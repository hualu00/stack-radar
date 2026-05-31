import type { TokenUsage } from '../types/ai.js';

/**
 * Model-agnostic structured-output transport, shared by the changelog evidence
 * client (M5) and the trend extractor (M9). A `LlmPrompt` is just system + user
 * + JSON schema; the transport returns the raw parsed JSON + token usage. Tests
 * inject a fake transport so the suite never calls the real API.
 */
export interface LlmPrompt {
  system: string;
  user: string;
  /** JSON schema for `output_config.format` (structured output). */
  schema: Record<string, unknown>;
}

export interface TransportResult {
  raw: unknown;
  usage: TokenUsage;
}

export interface LlmTransport {
  complete(prompt: LlmPrompt): Promise<TransportResult>;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/** The real transport. Lazy-imports the SDK so the no-AI path never loads it. */
export function createAnthropicTransport(model: string, apiKey?: string, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS): LlmTransport {
  return {
    async complete(prompt: LlmPrompt): Promise<TransportResult> {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic(apiKey ? { apiKey } : {});
      // No `temperature`: models after Opus 4.6 (incl. the default Sonnet 4.6) reject
      // any non-1.0 value with a 400. Determinism comes from the disk cache, not sampling.
      const message = await client.messages.create({
        model,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
        // cache_control on the stable system+schema prefix: cached across the
        // per-item calls in one run (the per-item text comes after it).
        system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: prompt.user }],
        output_config: { format: { type: 'json_schema', schema: prompt.schema } },
      });

      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null; // validators turn this into low-quality / empty output
      }
      const u = message.usage;
      return {
        raw,
        usage: {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
