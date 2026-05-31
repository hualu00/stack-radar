#!/usr/bin/env node
import { Command } from 'commander';
import { runCheckUpdates } from './commands/check-updates.js';
import { runFeedback } from './commands/feedback.js';
import { runInitProfile } from './commands/init-profile.js';
import { runRecommend } from './commands/recommend.js';
import { runScan } from './commands/scan.js';
import { runScanApiUsage } from './commands/scan-api-usage.js';
import { runWatchTrends } from './commands/watch-trends.js';
import type { AiProgressEvent, AiStartInfo } from './types/ai.js';
import { DECISION_ACTIONS, type DecisionAction } from './types/decision.js';

const program = new Command();

program
  .name('stack-radar')
  .description('Dependency intelligence CLI for frontend repos')
  .version('0.1.0');

program
  .command('scan')
  .description('Scan a repo and write .stack-radar/stack.json')
  .option('--repo <path>', 'path to the repo to scan', '.')
  .action((opts: { repo: string }) => {
    try {
      runScan({ repo: opts.repo });
    } catch (err) {
      console.error(`stack-radar scan failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('check-updates')
  .description('Fetch update intelligence for stack.json and write .stack-radar/updates.json')
  .option('--repo <path>', 'path to the repo to scan', '.')
  .option('--refresh', 'ignore cache and re-fetch', false)
  .action(async (opts: { repo: string; refresh?: boolean }) => {
    try {
      await runCheckUpdates({ repo: opts.repo, refresh: opts.refresh });
    } catch (err) {
      console.error(`stack-radar check-updates failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('init-profile')
  .description('Draft .stack-radar/project-profile.yaml from the repo (every field needs review)')
  .option('--repo <path>', 'path to the repo to scan', '.')
  .option('--force', 'overwrite an existing profile', false)
  .action((opts: { repo: string; force?: boolean }) => {
    try {
      runInitProfile({ repo: opts.repo, force: opts.force });
    } catch (err) {
      console.error(`stack-radar init-profile failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('scan-api-usage')
  .description('Count local usage of given API identifiers (counts only — no file paths)')
  .requiredOption('--apis <list>', 'comma-separated API identifiers to search for')
  .option('--repo <path>', 'path to the repo to scan', '.')
  .option('--package <name>', 'package the APIs belong to (label only)')
  .action(async (opts: { repo: string; apis: string; package?: string }) => {
    try {
      await runScanApiUsage({ repo: opts.repo, apis: opts.apis, package: opts.package });
    } catch (err) {
      console.error(`stack-radar scan-api-usage failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('recommend')
  .description('Score updates.json and write a Markdown report to .stack-radar/reports/')
  .option('--repo <path>', 'path to the repo to scan', '.')
  .option('--profile <path>', 'project profile YAML (defaults to .stack-radar/project-profile.yaml if present)')
  .option('--no-profile', 'ignore any profile and use global scoring')
  .option('--out <file>', 'write the report to this exact path instead of the dated reports/ file')
  .option('--use-ai', 'extract changelog evidence via the Claude API (needs ANTHROPIC_API_KEY)', false)
  .option('--dry-run', 'with --use-ai: print the prompts without calling the API', false)
  .option('--ai-model <model>', 'AI model to use (default: claude-sonnet-4-6)')
  .option('--refresh', 're-run AI analysis even when a cached analysis exists', false)
  .action(
    async (opts: {
      repo: string;
      profile?: string | boolean;
      out?: string;
      useAi?: boolean;
      dryRun?: boolean;
      aiModel?: string;
      refresh?: boolean;
    }) => {
      try {
        // commander sets opts.profile to `false` for --no-profile, or a string path for --profile.
        const noProfile = opts.profile === false;
        const profile = typeof opts.profile === 'string' ? opts.profile : undefined;
        await runRecommend({
          repo: opts.repo,
          profile,
          noProfile,
          out: opts.out,
          useAi: opts.useAi,
          dryRun: opts.dryRun,
          aiModel: opts.aiModel,
          refresh: opts.refresh,
          onAiStart: opts.useAi ? printAiStart : undefined,
          onAiProgress: opts.useAi ? printAiProgress : undefined,
        });
      } catch (err) {
        console.error(`stack-radar recommend failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    },
  );

program
  .command('feedback')
  .description('Record a decision (snooze/decline/accept) into .stack-radar/decisions.json')
  .requiredOption('--package <name>', 'package the decision applies to')
  .requiredOption('--action <action>', `one of: ${DECISION_ACTIONS.join(', ')}`)
  .option('--repo <path>', 'path to the repo', '.')
  .option('--version-range <range>', 'scope the decision to versions matching this semver range (e.g. "19.x")')
  .option('--until <date>', 'snooze end date (YYYY-MM-DD); required for snooze')
  .option('--reason <text>', 'rationale, surfaced in the report')
  .action((opts: { repo: string; package: string; action: string; versionRange?: string; until?: string; reason?: string }) => {
    try {
      runFeedback({
        repo: opts.repo,
        package: opts.package,
        action: opts.action as DecisionAction, // validated in runFeedback (throws on bad value)
        versionRange: opts.versionRange,
        until: opts.until,
        reason: opts.reason,
      });
    } catch (err) {
      console.error(`stack-radar feedback failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('watch-trends')
  .description('Watch community feeds → .stack-radar/community-watchlist.md (independent of upgrade scoring)')
  .option('--repo <path>', 'path to the repo', '.')
  .option('--dry-run', 'print extraction prompts without calling the API', false)
  .option('--refresh', 're-extract even when a cached extraction exists', false)
  .option('--ai-model <model>', 'AI model to use (default: claude-sonnet-4-6)')
  .action(async (opts: { repo: string; dryRun?: boolean; refresh?: boolean; aiModel?: string }) => {
    try {
      await runWatchTrends({ repo: opts.repo, dryRun: opts.dryRun, refresh: opts.refresh, aiModel: opts.aiModel });
    } catch (err) {
      console.error(`stack-radar watch-trends failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

// Progress reporters for `recommend --use-ai`. Written to stderr so the final
// summary on stdout stays clean for piping.
function printAiStart(info: AiStartInfo): void {
  const noun = info.dry_run ? (info.total === 1 ? 'prompt' : 'prompts') : info.total === 1 ? 'package' : 'packages';
  const line = info.dry_run
    ? `AI dry-run: printing ${info.total} ${noun} (no API calls)...`
    : `AI analyzing ${info.total} ${noun} with ${info.model}...`;
  process.stderr.write(`${line}\n`);
}

function printAiProgress(e: AiProgressEvent): void {
  const idx = String(e.completed_count).padStart(String(e.total).length);
  const status =
    e.status === 'fresh' && e.usage
      ? `fresh (${e.usage.input_tokens}/${e.usage.output_tokens} tok)`
      : e.status;
  process.stderr.write(`  [${idx}/${e.total}] ${e.package} — ${status}\n`);
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
