import { CircuitBreaker, CircuitOpenError, retry, TimeoutError } from '@autodeploy/resilience';
import type { z } from 'zod';
import { SYSTEM_PROMPT } from './context.js';
import { isRetryable, type Provider, ProviderError } from './providers.js';
import { Classification, Diagnosis, jsonSchemaOf, PatchProposal } from './schemas.js';

// Provider-independent gateway: tries providers in priority order, each behind
// its own circuit breaker, validates every response against a schema, and
// records usage. If every provider fails, callers fall back to rules only.

export type Purpose = 'classify' | 'diagnose' | 'patch';
export type Outcome =
  | 'ok'
  | 'error'
  | 'invalid_output'
  | 'rate_limited'
  | 'timeout'
  | 'circuit_open';

export type UsageRecord = {
  provider: string;
  model: string;
  purpose: Purpose;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  outcome: Outcome;
};

export type GatewayOptions = {
  /** Providers for diagnosis and patches, highest priority first. */
  providers: Provider[];
  /** Cheap model for classification; falls back to `providers` when unset. */
  classifier?: Provider;
  onUsage?: (u: UsageRecord) => void | Promise<void>;
  /** Returns false when the daily call budget is spent. */
  budget?: () => Promise<boolean>;
  timeoutMs?: number;
  onBreakerChange?: (provider: string, state: string) => void;
};

export class AiUnavailableError extends Error {
  constructor(readonly attempts: Array<{ provider: string; outcome: Outcome; message: string }>) {
    super(
      `no AI provider succeeded: ${attempts.map((a) => `${a.provider}=${a.outcome}`).join(', ') || 'none configured'}`,
    );
    this.name = 'AiUnavailableError';
  }
}

export class AiGateway {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly o: GatewayOptions) {
    for (const p of [...o.providers, ...(o.classifier ? [o.classifier] : [])]) {
      if (!this.breakers.has(p.name)) {
        this.breakers.set(
          p.name,
          new CircuitBreaker(p.name, {
            failureThreshold: 3,
            cooldownMs: 60_000,
            onStateChange: (s) => o.onBreakerChange?.(p.name, s),
          }),
        );
      }
    }
  }

  get available(): boolean {
    return this.o.providers.length > 0;
  }

  breakerStates(): Record<string, string> {
    return Object.fromEntries([...this.breakers].map(([k, b]) => [k, b.state]));
  }

  classify(context: string) {
    const chain = this.o.classifier ? [this.o.classifier, ...this.o.providers] : this.o.providers;
    return this.call(chain, 'classify', Classification, 'classification', context, 300);
  }

  diagnose(context: string) {
    return this.call(
      this.o.providers,
      'diagnose',
      Diagnosis,
      'diagnosis',
      `Diagnose this failed build.\n\n${context}`,
      900,
    );
  }

  proposePatch(context: string, diagnosis: Diagnosis) {
    const prompt = `Diagnosis: ${diagnosis.summary}\nCause: ${diagnosis.cause}\n\nWrite the smallest unified diff that fixes the build, or an empty diff if unsure.\n\n${context}`;
    return this.call(this.o.providers, 'patch', PatchProposal, 'patch', prompt, 2000);
  }

  private async call<T>(
    chain: Provider[],
    purpose: Purpose,
    schema: z.ZodType<T>,
    schemaName: string,
    prompt: string,
    maxTokens: number,
  ): Promise<{ value: T; provider: string; model: string }> {
    if (this.o.budget && !(await this.o.budget())) {
      throw new AiUnavailableError([
        { provider: 'budget', outcome: 'rate_limited', message: 'daily AI budget spent' },
      ]);
    }
    const attempts: Array<{ provider: string; outcome: Outcome; message: string }> = [];
    for (const provider of chain) {
      const breaker = this.breakers.get(provider.name);
      const started = Date.now();
      let usage: Partial<UsageRecord> = {};
      try {
        const value = await (
          breaker ?? new CircuitBreaker('adhoc', { failureThreshold: 99, cooldownMs: 0 })
        ).exec(
          () =>
            retry(
              async () => {
                const res = await provider.chat({
                  messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: prompt },
                  ],
                  jsonSchema: jsonSchemaOf(schema, schemaName),
                  maxTokens,
                  timeoutMs: this.o.timeoutMs ?? 45_000,
                });
                usage = {
                  model: res.model,
                  tokensIn: res.tokensIn ?? null,
                  tokensOut: res.tokensOut ?? null,
                };
                return parseJson(res.content, schema);
              },
              {
                attempts: 2,
                baseMs: 1_000,
                retryable: isRetryable,
                retryAfterMs: (e) => (e instanceof ProviderError ? e.retryAfterMs : undefined),
              },
            ),
          // Invalid output is the model's fault, not an outage: don't trip the breaker.
          (err) => !(err instanceof InvalidOutputError),
        );
        await this.record(provider, purpose, started, usage, 'ok');
        return { value, provider: provider.name, model: usage.model ?? provider.model };
      } catch (err) {
        const outcome = outcomeOf(err);
        attempts.push({
          provider: provider.name,
          outcome,
          message: (err as Error).message.slice(0, 200),
        });
        await this.record(provider, purpose, started, usage, outcome);
      }
    }
    throw new AiUnavailableError(attempts);
  }

  private async record(
    p: Provider,
    purpose: Purpose,
    started: number,
    usage: Partial<UsageRecord>,
    outcome: Outcome,
  ) {
    await this.o.onUsage?.({
      provider: p.name,
      model: usage.model ?? p.model,
      purpose,
      tokensIn: usage.tokensIn ?? null,
      tokensOut: usage.tokensOut ?? null,
      latencyMs: Date.now() - started,
      outcome,
    });
  }
}

export class InvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutputError';
  }
}

function parseJson<T>(content: string, schema: z.ZodType<T>): T {
  // Some models wrap JSON in fences despite instructions; strip them only.
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new InvalidOutputError('model did not return JSON');
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new InvalidOutputError(
      `schema mismatch: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  return parsed.data;
}

function outcomeOf(err: unknown): Outcome {
  if (err instanceof CircuitOpenError) return 'circuit_open';
  if (err instanceof InvalidOutputError) return 'invalid_output';
  if (err instanceof TimeoutError) return 'timeout';
  if (err instanceof ProviderError && err.rateLimited) return 'rate_limited';
  return 'error';
}
