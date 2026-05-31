import type { Relevance } from '../types/relevance.js';
import type { Dimension, Recommendation } from '../types/score.js';
import type { UpdateRecord } from '../types/update.js';
import type { BlockedResult } from './blocked.js';

export interface RecommendInput {
  record: UpdateRecord;
  blocked: BlockedResult;
  risk: Dimension;
  value: Dimension;
  /** Code-relevance scan (M6), present only when --use-ai ran a scan. */
  relevance?: Relevance;
}

/**
 * Map dimensions + signals to a Recommendation. Priority-ordered and pure for
 * determinism (PLAN §8). Low-risk security → Upgrade Now; high-risk security →
 * Review First. Defer is reserved for high-risk updates with no benefit evidence.
 */
export function decideRecommendation({ record, blocked, risk, value, relevance }: RecommendInput): Recommendation {
  if (blocked.blocked) return 'Blocked';

  if (record.signals.security) return risk === 'high' ? 'Review First' : 'Upgrade Now';

  if (record.update_type === 'prerelease') return 'Watch';

  if (risk === 'high') {
    // M6: a breaking/major change whose changed APIs are demonstrably unused here
    // → Watch (keep an eye out, but it doesn't touch your code). Gated hard: a
    // complete scan that actually searched valid APIs and found zero usage, and
    // not a deprecation (today's deprecation signal can't tell "unused API" from
    // "package deprecated"). Security/prerelease already returned above.
    const unused =
      relevance?.scanned === true &&
      relevance.mentioned > 0 &&
      !relevance.capped &&
      relevance.total_matches === 0;
    if (unused && !record.signals.deprecation) return 'Watch';

    const noBenefitEvidence = !record.signals.deprecation && record.release_notes.length === 0;
    const lowValue = value === 'low' || value === 'none';
    return noBenefitEvidence && lowValue ? 'Defer' : 'Review First';
  }

  if (record.signals.deprecation || record.signals.peer_dependency_changed) return 'Review First';

  if ((record.update_type === 'patch' || record.update_type === 'minor') && risk === 'low' && !record.signals.breaking) {
    return 'Safe to Upgrade';
  }

  return 'Review First';
}
