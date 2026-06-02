import { join, resolve } from 'node:path';
import { createAiClient } from '../ai/client.js';
import { type AiBackend, CLI_ADAPTERS, type CliRunner, createCliTransport, resolveModel } from '../ai/cli-transport.js';
import type { AnalysisPrompt } from '../ai/prompts/changelog-analysis.js';
import { applyDecision, effectiveRecommendation, isActiveSnooze, resolveDecision } from '../decisions/apply.js';
import { loadDecisions } from '../decisions/store.js';
import { type ApiSearcher, createApiSearcher } from '../relevance/searcher.js';
import { renderReport, type ScoredRecord } from '../report/markdown.js';
import { nodeEngineDivergenceNote } from '../scoring/blocked.js';
import { buildProjectContext, finalRecommendation, scoreRecord } from '../scoring/index.js';
import { hasUnreviewedMarkers, parseProfile } from '../scoring/profile.js';
import type { AiEvidence, AiProgressEvent, AiRunSummary, AnalysisInput, AiStartInfo } from '../types/ai.js';
import type { Decision } from '../types/decision.js';
import { recordKey } from '../types/update.js';
import type { ProjectProfile } from '../types/profile.js';
import type { Relevance } from '../types/relevance.js';
import type { StackJson } from '../types/stack.js';
import type { UpdateRecord } from '../types/update.js';
import { Cache } from '../utils/cache.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { fileExists, readJson, readText, writeText } from '../utils/fs.js';

export interface RecommendOptions {
  repo: string;
  /** Override the report date (YYYY-MM-DD); defaults to today. For deterministic tests. */
  date?: string;
  /** Explicit profile path; when omitted, auto-loads .stack-radar/project-profile.yaml if present. */
  profile?: string;
  /** Force global scoring even when a default profile exists. */
  noProfile?: boolean;
  /** Write the report to this exact path instead of the dated reports/ file. */
  out?: string;
  /** Use the Claude API to extract changelog evidence (M5). */
  useAi?: boolean;
  /** With useAi: print prompts without calling the API. */
  dryRun?: boolean;
  /** AI model override. Default depends on the backend (api → sonnet; claude-cli → Opus). */
  aiModel?: string;
  /** Which AI backend to use (default 'api' = Anthropic API). 'claude-cli'/'codex-cli' shell out to the local CLI. */
  aiBackend?: AiBackend;
  /** Override the local AI CLI executable path (with a CLI backend). */
  aiCommand?: string;
  /** Re-analyze with the AI even if a cached analysis exists. */
  refresh?: boolean;
  /** Injected in tests so AI wiring runs offline. */
  aiClient?: { analyze(input: AnalysisInput): Promise<{ evidence: AiEvidence; usage: import('../types/ai.js').TokenUsage | null; cached: boolean }> };
  /** Injected in tests so the code-relevance scan runs offline. */
  searcher?: ApiSearcher;
  /** Injected in tests so a CLI backend runs offline (no real subprocess). */
  cliRunner?: CliRunner;
  /** Called once before the AI fan-out begins; CLI prints a header. */
  onAiStart?: (info: AiStartInfo) => void;
  /** Called once per record as AI analysis completes (in completion order). */
  onAiProgress?: (event: AiProgressEvent) => void;
}

interface ResolvedProfile {
  profile: ProjectProfile;
  source: string;
  reviewed: boolean;
}

const AI_CONCURRENCY = 4;
/** CLI backends spawn agentic child processes — keep the fan-out at 1 to avoid
 * provider/session locks, rate limits, and local config writes. */
const CLI_CONCURRENCY = 1;

/** A record is scored into the 6 sections only if it has a real, resolvable update. */
function isScorable(r: UpdateRecord): boolean {
  return (r.status === 'ok' || r.status === 'partial') && r.update_type !== 'none' && r.update_type !== 'unknown';
}

/** Local (not UTC) YYYY-MM-DD, so an evening run doesn't produce "tomorrow"'s report. */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Build the AI input for one record — the privacy boundary. ONLY public package
 * metadata, persisted changelog text, and the coarse profile cross this line.
 * No source code, no file paths (PLAN §14).
 */
function buildAnalysisInput(record: UpdateRecord, profile: ProjectProfile | undefined): AnalysisInput {
  return {
    package: record.resolved_name ?? record.name,
    locked_version: record.locked_version,
    latest_version: record.latest_version,
    update_type: record.update_type,
    notes: record.release_notes
      .filter((n): n is typeof n & { text: string } => typeof n.text === 'string' && n.text.trim() !== '')
      .map((n) => ({ version: n.version, url: n.url, source: n.source, text: n.text, truncated: n.text_truncated })),
    profile: profile ? { product_type: profile.product_type, tech_taste: profile.tech_taste } : null,
  };
}

function resolveProfile(repoPath: string, options: RecommendOptions): ResolvedProfile | null {
  if (options.noProfile) return null;
  const defaultPath = join(repoPath, '.stack-radar', 'project-profile.yaml');
  const path = options.profile ? resolve(options.profile) : fileExists(defaultPath) ? defaultPath : null;
  if (!path) return null;

  const text = readText(path);
  if (text === null) throw new Error(`Profile not found or unreadable: ${path}`);
  const profile = parseProfile(text);
  const reviewed = !hasUnreviewedMarkers(text);
  if (!reviewed) {
    console.error(`WARNING: ${path} still contains "# NEEDS REVIEW" markers — recommendations may be skewed. Review the profile.`);
  }
  return { profile, source: path, reviewed };
}

/**
 * Run `recommend`: read stack.json + updates.json, optionally extract AI evidence,
 * score each update, and write a Markdown report. AI (when enabled) only informs
 * Confidence + the report — never the recommendation. Async because of `--use-ai`.
 */
export async function runRecommend(options: RecommendOptions): Promise<void> {
  const repoPath = resolve(options.repo);
  const stack = readJson<StackJson>(join(repoPath, '.stack-radar', 'stack.json'));
  if (!stack || !Array.isArray(stack.items)) {
    throw new Error('No valid stack.json — run `stack-radar scan` first.');
  }
  const updates = readJson<UpdateRecord[]>(join(repoPath, '.stack-radar', 'updates.json'));
  if (!Array.isArray(updates)) {
    throw new Error('No valid updates.json — run `stack-radar check-updates` first.');
  }
  if (updates.length > 0 && updates.every((r) => r.requirements === undefined)) {
    throw new Error('updates.json predates this version (no requirements) — re-run `stack-radar check-updates`.');
  }

  const resolvedProfile = resolveProfile(repoPath, options);
  const profile = resolvedProfile?.profile;
  const scorables = updates.filter(isScorable);
  const date = options.date ?? localDate(new Date());

  // Feedback layer (M7, PLAN §11): load recorded decisions and resolve the one
  // governing each record. An active snooze HIDES a record, so it also skips AI +
  // relevance entirely — no tokens spent on something the report won't show.
  const decisions = loadDecisions(repoPath);
  const decisionByRecord = new Map<UpdateRecord, Decision | null>(scorables.map((r) => [r, resolveDecision(r, decisions)]));
  const isHidden = (r: UpdateRecord): boolean => {
    const d = decisionByRecord.get(r) ?? null;
    return d !== null && isActiveSnooze(d, date);
  };

  const { evidenceByKey, relevanceByKey, aiUsage } = await runAi(repoPath, scorables.filter((r) => !isHidden(r)), profile, options);

  const ctx = resolvedProfile
    ? buildProjectContext(stack, { profileNode: profile?.hard_constraints.node ?? null, reviewed: resolvedProfile.reviewed })
    : buildProjectContext(stack);
  const divergence = nodeEngineDivergenceNote(stack.runtime.node_engine, ctx.nodeEngine);
  if (divergence) console.error(`WARNING: ${divergence}`);
  const scored: ScoredRecord[] = scorables.map((record) => {
    const key = recordKey(record);
    const evidence = evidenceByKey.get(key);
    const relevance = relevanceByKey.get(key);
    const score = scoreRecord(record, ctx, profile, evidence, relevance);
    const decision = applyDecision(finalRecommendation(score), record, decisionByRecord.get(record) ?? null, date);
    return { record, score, evidence, relevance, decision };
  });

  const outPath = options.out ? resolve(options.out) : join(repoPath, '.stack-radar', 'reports', `${date}.md`);
  writeText(outPath, renderReport(stack, scored, updates, date, profile ?? null, aiUsage));

  // Summary buckets by the EFFECTIVE recommendation and excludes hidden snoozes.
  const byRec = new Map<string, number>();
  let snoozed = 0;
  for (const s of scored) {
    if (s.decision?.hidden) {
      snoozed += 1;
      continue;
    }
    const rec = effectiveRecommendation(s.score, s.decision);
    byRec.set(rec, (byRec.get(rec) ?? 0) + 1);
  }
  const summary = ['Upgrade Now', 'Safe to Upgrade', 'Review First', 'Watch', 'Blocked', 'Defer']
    .map((r) => `${r}: ${byRec.get(r) ?? 0}`)
    .join(' | ');

  console.log(`Recommended ${scored.length - snoozed} updates (of ${updates.length} records)`);
  console.log(resolvedProfile ? `  Profile: ${profile?.product_type} / ${profile?.tech_taste} (${resolvedProfile.source})` : '  Profile: none (global scoring)');
  if (aiUsage) {
    const tok = aiUsage.backend === 'codex-cli' ? 'tokens n/a' : `${aiUsage.input_tokens}/${aiUsage.output_tokens} tok`;
    console.log(aiUsage.dry_run ? `  AI: dry-run (no calls), backend ${aiUsage.backend}, model ${aiUsage.model}` : `  AI: ${aiUsage.model} (${aiUsage.backend}) — ${aiUsage.calls} calls, ${aiUsage.cached} cached, ${tok}`);
  }
  console.log(`  ${summary}`);
  if (snoozed > 0) console.log(`  Snoozed (hidden): ${snoozed}`);
  console.log(`  -> ${outPath}`);
}

interface AiRun {
  evidenceByKey: Map<string, AiEvidence>;
  relevanceByKey: Map<string, Relevance>;
  aiUsage: AiRunSummary | undefined;
}

/**
 * Analyze every scorable record (when --use-ai), aggregating tokens, and run a
 * local code-relevance scan on each record's AI-extracted `mentioned_apis`. One
 * shared searcher (so its per-API cache amortizes across packages); the AI map's
 * concurrency bounds the ripgrep subprocess fan-out.
 */
async function runAi(
  repoPath: string,
  scorables: UpdateRecord[],
  profile: ProjectProfile | undefined,
  options: RecommendOptions,
): Promise<AiRun> {
  const evidenceByKey = new Map<string, AiEvidence>();
  const relevanceByKey = new Map<string, Relevance>();
  if (!options.useAi) return { evidenceByKey, relevanceByKey, aiUsage: undefined };

  const backend = options.aiBackend ?? 'api';
  const model = resolveModel(backend, options.aiModel);
  // Every scorable was hidden (snoozed): nothing to analyze, so don't even require a
  // key or build a client — AI truly runs only on records the report will show.
  if (scorables.length === 0) {
    return {
      evidenceByKey,
      relevanceByKey,
      aiUsage: { model, backend, analyzed: 0, calls: 0, cached: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, dry_run: options.dryRun === true },
    };
  }
  // Only the api backend needs a key; the CLI backends ride the CLI's own subscription login.
  if (backend === 'api' && !options.dryRun && !options.aiClient && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — required for `recommend --use-ai` with the api backend (use --dry-run, or --ai-backend claude-cli|codex-cli).');
  }

  // CLI backends inject a CLI-backed transport; api passes none → createAiClient builds the Anthropic default.
  const transport =
    backend === 'api'
      ? undefined
      : createCliTransport({ adapter: CLI_ADAPTERS[backend], model, command: options.aiCommand, runner: options.cliRunner });
  const client =
    options.aiClient ??
    createAiClient({
      model,
      backend,
      transport,
      cache: new Cache(join(repoPath, '.stack-radar', 'cache')),
      dryRun: options.dryRun,
      refresh: options.refresh,
      onDryRun: printPrompt,
    });
  const searcher = options.searcher ?? createApiSearcher();

  options.onAiStart?.({ total: scorables.length, model, dry_run: options.dryRun === true });

  // dry-run keeps prompt output ordered; CLI backends spawn subprocesses → keep their fan-out at 1.
  const concurrency = options.dryRun ? 1 : backend === 'api' ? AI_CONCURRENCY : CLI_CONCURRENCY;
  let done = 0;
  const results = await mapWithConcurrency(scorables, concurrency, async (record) => {
    const ai = await client.analyze(buildAnalysisInput(record, profile));
    // Scan the APIs the AI named against the repo (skip in dry-run — no real evidence).
    const relevance =
      !options.dryRun && ai.evidence.mentioned_apis.length > 0
        ? await searcher.search(repoPath, ai.evidence.mentioned_apis)
        : undefined;
    done += 1;
    options.onAiProgress?.({
      completed_count: done,
      total: scorables.length,
      package: record.resolved_name ?? record.name,
      status: options.dryRun
        ? 'dry-run'
        : ai.cached
          ? 'cached'
          : ai.evidence.evidence_quality === 'unavailable'
            ? 'unavailable'
            : 'fresh',
      usage: ai.usage,
    });
    return { key: recordKey(record), result: ai, relevance };
  });

  let calls = 0;
  let cached = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const { key, result, relevance } of results) {
    evidenceByKey.set(key, result.evidence);
    if (relevance) relevanceByKey.set(key, relevance);
    if (result.cached) cached += 1;
    if (result.usage) {
      calls += 1;
      inputTokens += result.usage.input_tokens;
      outputTokens += result.usage.output_tokens;
      cacheReadTokens += result.usage.cache_read_input_tokens;
      cacheCreationTokens += result.usage.cache_creation_input_tokens;
    }
  }

  return {
    evidenceByKey,
    relevanceByKey,
    aiUsage: {
      model,
      backend,
      analyzed: scorables.length,
      calls,
      cached,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      dry_run: options.dryRun === true,
    },
  };
}

/** Dry-run prompt printer (stdout, so it can be redirected for a privacy audit). */
function printPrompt(input: AnalysisInput, prompt: AnalysisPrompt): void {
  console.log(`\n===== AI PROMPT: ${input.package} ${input.locked_version ?? '?'} -> ${input.latest_version ?? '?'} =====`);
  console.log('--- system ---');
  console.log(prompt.system);
  console.log('--- user ---');
  console.log(prompt.user);
}
