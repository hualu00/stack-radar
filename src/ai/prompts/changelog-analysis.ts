import { EVIDENCE_TYPES, MODEL_EVIDENCE_QUALITIES, type AnalysisInput } from '../../types/ai.js';

/**
 * Bumped when the prompt or output schema changes in a way that should
 * invalidate cached AI analyses. Part of the AI cache key.
 */
export const PROMPT_VERSION = 1;

export interface AnalysisPrompt {
  system: string;
  user: string;
  /** JSON schema for `output_config.format` (structured output). */
  schema: Record<string, unknown>;
}

const SYSTEM = `You extract structured, factual evidence from software changelog/release-note text for a dependency-upgrade report.

Rules:
- Use ONLY the changelog text provided in the user message. Do NOT use prior knowledge about the package.
- NEVER fabricate. Every "quote" MUST be copied verbatim (an exact substring) from a single note's text, and that evidence item's "url" MUST be the SAME note's url. Do not mix a quote from one note with another note's url.
- If the provided text is empty, irrelevant, or too thin to support a claim, set evidence_quality to "low" and leave the evidence array and signal arrays empty.
- evidence_quality reflects how well the TEXT supports your extraction: "high" = clear release notes directly describing the changes; "medium" = partial/ambiguous; "low" = little or no usable text.
- Classify each evidence item's "type" as one of: ${EVIDENCE_TYPES.join(', ')}.
- "summary" is one or two plain sentences for an engineer deciding whether to upgrade. No marketing language.
- You do NOT decide whether to upgrade and you do NOT assign a recommendation or confidence level — only extract evidence.
- Output MUST conform exactly to the provided JSON schema.`;

/** Build the (system, user, schema) for analyzing one package's changelog. */
export function buildAnalysisPrompt(input: AnalysisInput): AnalysisPrompt {
  const lines: string[] = [];
  lines.push(`Package: ${input.package}`);
  lines.push(`Update: ${input.locked_version ?? '?'} -> ${input.latest_version ?? '?'} (${input.update_type})`);
  if (input.profile) {
    lines.push(`Project profile (for tailoring the summary only): product_type=${input.profile.product_type}, tech_taste=${input.profile.tech_taste}`);
  }
  lines.push('');
  if (input.notes.length === 0) {
    lines.push('Release notes: (none provided)');
  } else {
    lines.push('Release notes (quote only from within a single note; cite that note\'s url):');
    input.notes.forEach((note, i) => {
      const trunc = note.truncated ? ' (text truncated)' : '';
      lines.push('');
      lines.push(`BEGIN_NOTE id=${i} version=${note.version} source=${note.source} url=${note.url}${trunc}`);
      lines.push(note.text);
      lines.push(`END_NOTE id=${i}`);
    });
  }
  lines.push('');
  lines.push(`Extract evidence for "${input.package}" as JSON matching the schema.`);

  return { system: SYSTEM, user: lines.join('\n'), schema: OUTPUT_SCHEMA };
}

const stringArray = { type: 'array', items: { type: 'string' } } as const;

/** JSON schema for the AI's structured output. Obeys structured-output limits
 * (additionalProperties:false on every object; enums; no min/max constraints). */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    package: { type: 'string' },
    summary: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'string' },
          type: { type: 'string', enum: [...EVIDENCE_TYPES] },
          quote: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['version', 'type', 'quote', 'url'],
      },
    },
    extracted_signals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        security_related: { type: 'boolean' },
        breaking_changes: stringArray,
        deprecations: stringArray,
        bugfixes: stringArray,
        performance_improvements: stringArray,
        new_features: stringArray,
      },
      required: ['security_related', 'breaking_changes', 'deprecations', 'bugfixes', 'performance_improvements', 'new_features'],
    },
    mentioned_apis: stringArray,
    evidence_quality: { type: 'string', enum: [...MODEL_EVIDENCE_QUALITIES] },
    caveats: stringArray,
  },
  required: ['package', 'summary', 'evidence', 'extracted_signals', 'mentioned_apis', 'evidence_quality', 'caveats'],
};
