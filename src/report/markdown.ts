import { effectiveRecommendation } from '../decisions/apply.js';
import { confidenceReason } from '../scoring/dimensions.js';
import type { AiEvidence, AiRunSummary } from '../types/ai.js';
import type { DecisionEffect } from '../types/decision.js';
import type { ProjectProfile } from '../types/profile.js';
import type { Relevance } from '../types/relevance.js';
import type { Recommendation, ScoreResult } from '../types/score.js';
import type { StackJson } from '../types/stack.js';
import { recordKey, type UpdateRecord, type UpdateStatus } from '../types/update.js';

export interface ScoredRecord {
  record: UpdateRecord;
  score: ScoreResult;
  /** AI evidence (M5), present only when `recommend --use-ai` ran. */
  evidence?: AiEvidence;
  /** Code-relevance scan (M6), present only when a scan ran for this record. */
  relevance?: Relevance;
  /** Feedback decision effect (M7), present only when a decision governs this record. */
  decision?: DecisionEffect;
}

const SECTIONS: { rec: Recommendation; heading: string }[] = [
  { rec: 'Upgrade Now', heading: '🔴 Upgrade Now (security or fixes a current pain point)' },
  { rec: 'Safe to Upgrade', heading: '🟢 Safe to Upgrade' },
  { rec: 'Review First', heading: '🟡 Review First' },
  { rec: 'Watch', heading: '⚪ Watch' },
  { rec: 'Blocked', heading: '⛔ Blocked' },
  { rec: 'Defer', heading: '🟤 Defer' },
];

/** Action verb that opens the per-item TL;DR line; reason follows after an em-dash. */
const LEAD_VERB: Record<Recommendation, string> = {
  'Upgrade Now': 'Upgrade now',
  'Safe to Upgrade': 'Upgrade when convenient',
  'Review First': 'Review before merging',
  Watch: 'Wait',
  Blocked: 'Blocked',
  Defer: 'Defer',
};

/** Render the Markdown report (PLAN §9). `date` is injected for deterministic output. */
export function renderReport(
  stack: StackJson,
  scored: ScoredRecord[],
  allRecords: UpdateRecord[],
  date: string,
  profile: ProjectProfile | null = null,
  aiUsage?: AiRunSummary,
): string {
  const lines: string[] = [];
  lines.push(`# Stack Radar Report — ${date}`);
  lines.push(`Repo: ${stack.repo.name}`);
  lines.push(profile ? `Profile: ${profile.product_type} / ${profile.tech_taste}` : 'Profile: (none — global scoring)');
  lines.push('');

  // Bucket by the EFFECTIVE recommendation (profile adjustment + feedback). Active
  // snoozes are hidden from the sections (they still appear, labeled, in the appendix).
  const byRec = new Map<Recommendation, ScoredRecord[]>();
  for (const s of [...scored].sort(byNameLocked)) {
    if (s.decision?.hidden) continue;
    const rec = effectiveRecommendation(s.score, s.decision);
    const list = byRec.get(rec) ?? [];
    list.push(s);
    byRec.set(rec, list);
  }

  for (const section of SECTIONS) {
    lines.push(`## ${section.heading}`);
    const items = byRec.get(section.rec) ?? [];
    if (items.length === 0) {
      lines.push('');
      lines.push('_(none)_');
      lines.push('');
      continue;
    }
    for (const item of items) lines.push(...renderItem(item));
  }

  lines.push(...renderAppendix(allRecords, scored, aiUsage));
  return `${lines.join('\n')}\n`;
}

function renderItem({ record, score, evidence, relevance, decision }: ScoredRecord): string[] {
  const final = effectiveRecommendation(score, decision);
  const out: string[] = [];
  out.push('');
  out.push(`### ${record.name}: ${record.locked_version ?? '?'} → ${record.latest_version ?? '?'}`);
  if (record.resolved_name) out.push(`_(alias of ${record.resolved_name})_`);
  out.push('');
  out.push(`> **${LEAD_VERB[final]}** — ${renderLeadReason(final, record, score, relevance)}`);
  out.push('');
  const confReason = confidenceReason(record, evidence);
  out.push(`- **Recommendation:** ${final}`);
  out.push(`- **Confidence:** ${score.confidence}${confReason ? ` (${confReason})` : ''}`);
  out.push(`- **Update type:** ${record.update_type}`);
  if (evidence) out.push(`- **Evidence quality:** ${evidence.evidence_quality} (AI)`);
  if (decision) out.push(`- **Decision:** ${decision.note ? `${decision.marker} (reason: ${decision.note})` : decision.marker}`);
  out.push('');
  out.push('**Scoring breakdown**');
  out.push(`- Base: urgency=${score.urgency}, risk=${score.risk}, value=${score.value} → ${score.recommendation}`);
  out.push(`- Profile adjustment: ${renderAdjustment(score)}`);
  out.push('');
  // Lead Why with the AI summary only when it's real evidence; an `unavailable`
  // summary is a meta-message ("provider unavailable" / "no changelog") → caveat.
  const aiSummaryLeads = evidence !== undefined && evidence.evidence_quality !== 'unavailable' && evidence.summary.trim() !== '';
  out.push('**Why**');
  if (aiSummaryLeads) out.push(`- ${evidence.summary.trim()}`);
  for (const reason of score.reasons) out.push(`- ${reason}`);
  out.push('');
  out.push('**Evidence**');
  const aiItems = evidence?.evidence ?? [];
  if (aiItems.length > 0) {
    // AI-extracted, validated quotes (each verbatim from the cited note).
    for (const e of aiItems) out.push(`- v${e.version} (${e.type}): "${e.quote}" — ${e.url}`);
  } else if (record.release_notes.length === 0) {
    out.push('- No release notes found for this version range');
  } else {
    for (const note of record.release_notes) {
      out.push(`- v${note.version} — ${note.url} _(${note.source}, confidence: ${note.confidence})_`);
    }
  }
  out.push('');
  if (relevance?.scanned && relevance.mentioned > 0) {
    out.push('**Project relevance**');
    for (const u of relevance.apis) out.push(`- ${u.api}: ${u.match_count} matches across ${u.file_count} files`);
    if (relevance.total_matches === 0) out.push('- None of the changed APIs appear in this project');
    if (relevance.capped) out.push('- (API list capped; relevance is partial)');
    out.push('');
  }
  out.push('**Caveats**');
  const caveats = [...score.caveats, ...(evidence?.caveats ?? [])];
  if (evidence?.evidence_quality === 'unavailable' && evidence.summary.trim() !== '') {
    caveats.push(`AI evidence unavailable: ${evidence.summary.trim()}`);
  }
  for (const caveat of dedupe(caveats)) out.push(`- ${caveat}`);
  out.push('');
  return out;
}

/**
 * One-line, decision-relevant reason that follows "**<verb>** — " in the lead.
 * Picks the strongest available signal; falls back to a recommendation-shaped
 * default so the line always reads as a complete sentence.
 */
function renderLeadReason(
  rec: Recommendation,
  record: UpdateRecord,
  score: ScoreResult,
  relevance: Relevance | undefined,
): string {
  if (record.signals.security && record.advisories.length > 0) {
    const noun = record.advisories.length > 1 ? 'advisories' : 'advisory';
    const ids = record.advisories.map((a) => a.id).join(', ');
    return `security ${noun} ${ids}`;
  }
  // Deprecation precedes relevance: deprecation prevents the "unused changed APIs"
  // downgrade in the scorer, so the lead must not blame relevance for the rec.
  if (record.signals.deprecation) return "deprecation flagged — check what's affected";
  if (relevance?.scanned && !relevance.capped && relevance.mentioned > 0) {
    if (relevance.total_matches === 0) {
      return `none of the ${relevance.mentioned} changed APIs appear in this project`;
    }
    const used = relevance.apis.filter((u) => u.match_count > 0).length;
    if (record.signals.breaking) {
      return `breaking changes; this project uses ${used} of the ${relevance.mentioned} changed APIs`;
    }
    return `${used} of ${relevance.mentioned} changed APIs used in this project; no breaking changes detected`;
  }
  if (record.signals.breaking) return 'breaking changes detected — read the release notes';
  if (record.signals.peer_dependency_changed) return 'peer dependencies changed — check compatibility';
  if (record.signals.node_requirement_changed) return 'Node version requirement changed';
  switch (rec) {
    case 'Upgrade Now':
      return 'high-priority upgrade';
    case 'Safe to Upgrade':
      return `${record.update_type} update with no breaking changes detected`;
    case 'Review First':
      return `${record.update_type} update — review release notes`;
    case 'Watch':
      return 'monitor for now';
    case 'Blocked':
      // Profile-block reasons live in adjustment.reasons; base-block reasons in
      // score.reasons. score.caveats is unrelated (ambient warnings) — don't read it.
      return (
        (score.adjustment?.changed && score.adjustment.recommendation === 'Blocked' ? score.adjustment.reasons[0] : score.reasons[0]) ??
        'constraint not satisfied'
      );
    case 'Defer':
      return 'high risk with limited visible benefit';
  }
}

/** The "Profile adjustment:" line: the final rec + reasons when changed, else "none". */
function renderAdjustment(score: ScoreResult): string {
  const adj = score.adjustment;
  if (!adj || !adj.changed) return 'none';
  return `${adj.recommendation} (${adj.reasons.join('; ')})`;
}

function renderAppendix(allRecords: UpdateRecord[], scored: ScoredRecord[], aiUsage?: AiRunSummary): string[] {
  const out: string[] = [];
  out.push('## Appendix');
  out.push('');

  const counts = new Map<UpdateStatus, number>();
  let upToDate = 0;
  for (const r of allRecords) {
    counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    if (r.status === 'ok' && r.update_type === 'none') upToDate++;
  }
  out.push('### Data source status');
  const status = (s: UpdateStatus) => counts.get(s) ?? 0;
  out.push(
    `- ok: ${status('ok')} | partial: ${status('partial')} | not_found: ${status('not_found')} | error: ${status('error')} | skipped_private: ${status('skipped_private')} | up-to-date: ${upToDate}`,
  );
  out.push('');

  out.push('### Full dependency table');
  out.push('| Package | Locked | Latest | Type | Recommendation | Confidence |');
  out.push('|---|---|---|---|---|---|');
  const byKey = new Map(scored.map((s) => [recordKey(s.record), s]));
  for (const r of [...allRecords].sort((a, b) => a.name.localeCompare(b.name) || (a.locked_version ?? '').localeCompare(b.locked_version ?? ''))) {
    const s = byKey.get(recordKey(r));
    // Snoozed rows show their dated marker in place of a recommendation; declined
    // rows show the de-emphasized (effective) recommendation.
    const rec = !s ? `— (${unscoredLabel(r)})` : s.decision?.hidden ? s.decision.marker : effectiveRecommendation(s.score, s.decision);
    const conf = s ? s.score.confidence : '—';
    out.push(`| ${r.name} | ${r.locked_version ?? '?'} | ${r.latest_version ?? '?'} | ${r.update_type} | ${rec} | ${conf} |`);
  }
  out.push('');

  out.push('### Failed changelog fetches');
  const failed = allRecords.filter(
    (r) => r.status === 'ok' && r.update_type !== 'none' && r.update_type !== 'unknown' && r.release_notes.length === 0,
  );
  if (failed.length === 0) {
    out.push('_(none)_');
  } else {
    for (const r of failed.sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`- ${r.name}: no release notes (${r.note ?? 'no GitHub release or CHANGELOG.md found'})`);
    }
  }
  out.push('');

  out.push('### Token usage');
  if (!aiUsage) {
    out.push('- N/A (no AI calls in this run)');
  } else if (aiUsage.dry_run) {
    out.push(
      aiUsage.analyzed === 0
        ? '- AI dry-run: no prompts printed (all candidate records were snoozed)'
        : `- AI dry-run: prompts printed, no calls (backend ${aiUsage.backend}, model would be ${aiUsage.model})`,
    );
  } else {
    out.push(`- AI model: ${aiUsage.model} (backend: ${aiUsage.backend})`);
    out.push(`- Analyzed: ${aiUsage.analyzed} | AI calls: ${aiUsage.calls} | from local cache: ${aiUsage.cached}`);
    out.push(
      // codex CLI doesn't surface token counts → say so rather than print a misleading 0/0.
      aiUsage.backend === 'codex-cli'
        ? '- Tokens: not reported by the codex CLI'
        : `- Tokens: ${aiUsage.input_tokens} input / ${aiUsage.output_tokens} output (prompt cache: ${aiUsage.cache_read_input_tokens} read, ${aiUsage.cache_creation_input_tokens} written)`,
    );
  }
  return out;
}

/** Label for a record that wasn't scored into the sections (appendix table). */
function unscoredLabel(r: UpdateRecord): string {
  if (r.status !== 'ok') return r.status;
  if (r.update_type === 'none') return 'up-to-date';
  return 'unresolved'; // ok but unknown update_type (missing/invalid version)
}

/** Stable de-duplication preserving first-seen order. */
function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function byNameLocked(a: ScoredRecord, b: ScoredRecord): number {
  return (
    a.record.name.localeCompare(b.record.name) ||
    (a.record.locked_version ?? '').localeCompare(b.record.locked_version ?? '')
  );
}
