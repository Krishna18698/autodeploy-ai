import { diffToEdits } from '@autodeploy/core';
import { TimeoutError, withTimeout } from '@autodeploy/resilience';

// Providers all speak the OpenAI chat-completions dialect, so one adapter
// covers NVIDIA build.nvidia.com, OpenRouter and Cloudflare Workers AI.
// The mock provider makes the whole pipeline runnable with no API keys.

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatRequest = {
  messages: ChatMessage[];
  jsonSchema?: { name: string; schema: unknown; strict: boolean };
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
};

export type ChatResponse = {
  content: string;
  tokensIn?: number;
  tokensOut?: number;
  model: string;
};

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
  get rateLimited() {
    return this.status === 429;
  }
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export class OpenAICompatibleProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly model: string,
    private readonly opts: {
      structuredOutput: 'json_schema' | 'json_object' | 'none';
      extraHeaders?: Record<string, string>;
      /** Appended to the last user message, e.g. Qwen3's "/no_think" switch. */
      userSuffix?: string;
      /** Provider-specific request fields, e.g. OpenRouter's reasoning effort. */
      extraBody?: Record<string, unknown>;
    } = {
      structuredOutput: 'json_schema',
    },
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const responseFormat =
      req.jsonSchema && this.opts.structuredOutput === 'json_schema'
        ? { type: 'json_schema', json_schema: req.jsonSchema }
        : req.jsonSchema && this.opts.structuredOutput === 'json_object'
          ? { type: 'json_object' }
          : undefined;
    const res = await withTimeout(
      req.timeoutMs,
      (signal) =>
        fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            ...this.opts.extraHeaders,
          },
          body: JSON.stringify({
            model: this.model,
            messages: this.opts.userSuffix
              ? req.messages.map((m, i) =>
                  i === req.messages.length - 1 && m.role === 'user'
                    ? { ...m, content: `${m.content} ${this.opts.userSuffix}` }
                    : m,
                )
              : req.messages,
            max_tokens: req.maxTokens,
            temperature: req.temperature ?? 0.1,
            ...(responseFormat && { response_format: responseFormat }),
            ...this.opts.extraBody,
          }),
          signal,
        }),
      `${this.name} chat`,
    );
    if (!res.ok) {
      const ra = res.headers.get('retry-after');
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        this.name,
        res.status,
        text.slice(0, 300) || res.statusText,
        ra ? Number(ra) * 1000 : undefined,
      );
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content === '')
      throw new ProviderError(
        this.name,
        502,
        body.choices?.[0]?.finish_reason === 'length'
          ? `no answer within ${req.maxTokens} tokens (reasoning models spend them thinking)`
          : 'response had no message content',
      );
    return {
      content,
      ...(body.usage?.prompt_tokens !== undefined && { tokensIn: body.usage.prompt_tokens }),
      ...(body.usage?.completion_tokens !== undefined && {
        tokensOut: body.usage.completion_tokens,
      }),
      model: body.model ?? this.model,
    };
  }
}

/**
 * NVIDIA's reasoning models think before answering; with thinking on, a short
 * budget (the 300-token classifier) can run out before the answer starts.
 * 'default' leaves the model's own setting (for models without the switch).
 */
export const nvidia = (apiKey: string, model: string, thinking: 'on' | 'off' | 'default' = 'off') =>
  new OpenAICompatibleProvider('nvidia', 'https://integrate.api.nvidia.com/v1', apiKey, model, {
    // json_object only promises JSON, so models invented their own field names.
    structuredOutput: 'json_schema',
    ...(thinking !== 'default' && {
      extraBody: { chat_template_kwargs: { enable_thinking: thinking === 'on' } },
    }),
  });

export const openrouter = (apiKey: string, model: string) =>
  new OpenAICompatibleProvider('openrouter', 'https://openrouter.ai/api/v1', apiKey, model, {
    structuredOutput: 'json_schema',
    extraHeaders: { 'x-title': 'AutoDeploy' },
    // Every free model there now reasons first; keep it short so the answer
    // fits the token budget (the Workers AI classifier lost all of it).
    extraBody: { reasoning: { effort: 'low' } },
  });

export const workersAi = (accountId: string, apiToken: string, model: string) =>
  new OpenAICompatibleProvider(
    'workers-ai',
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    apiToken,
    model,
    {
      structuredOutput: 'json_schema',
      // Qwen3 reasons before answering by default and spends the whole
      // classifier budget (300 tokens) doing it; the answer never arrives.
      ...(/qwen3/i.test(model) && { userSuffix: '/no_think' }),
    },
  );

/**
 * Deterministic stand-in for local development and tests. It "diagnoses" from
 * the error text and, for repair demos, returns the patch found in a
 * `.autodeploy/mock-fix.diff` file inside the repository if there is one.
 */
export class MockProvider implements Provider {
  readonly name = 'mock';
  readonly model = 'mock-1';
  constructor(private readonly latencyMs = 50) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    await new Promise((r) => setTimeout(r, this.latencyMs));
    const user = req.messages.at(-1)?.content ?? '';
    const schema = req.jsonSchema?.name;
    let content: unknown;
    if (schema === 'classification') {
      const code = /Error code: (\w+)/.exec(user)?.[1] ?? 'UNKNOWN';
      content = {
        category:
          code === 'TS_COMPILE' || code === 'SYNTAX_ERROR'
            ? 'code'
            : code === 'MODULE_NOT_FOUND'
              ? 'dependency'
              : 'unknown',
        fixable: code === 'TS_COMPILE' || code === 'SYNTAX_ERROR' || code === 'MODULE_NOT_FOUND',
        reason: `mock classification for ${code}`,
      };
    } else if (schema === 'diagnosis') {
      const key = /Normalized key line: (.*)/.exec(user)?.[1] ?? 'unknown error';
      const files = [...user.matchAll(/file:([^\s>]+)/g)]
        .map((m) => m[1])
        .filter((f): f is string => Boolean(f));
      content = {
        summary: `Build failed: ${key.slice(0, 200)}`,
        cause: `The log's key line is "${key.slice(0, 300)}".`,
        filesToRead: [
          ...new Set([...files.filter((f) => f !== 'package.json'), '.autodeploy/mock-fix.diff']),
        ].slice(0, 6),
        confidence: 'medium',
      };
    } else if (schema === 'patch') {
      const m =
        /<<<UNTRUSTED-\w+ file:\.autodeploy\/mock-fix\.diff>>>\n([\s\S]*?)\n<<<END UNTRUSTED-\w+>>>/.exec(
          user,
        );
      content = m?.[1]
        ? {
            explanation: 'Applied the fix described by the repository fixture.',
            edits: diffToEdits(m[1]),
          }
        : { explanation: 'The mock provider has no fix for this repository.', edits: [] };
    } else {
      throw new ProviderError('mock', 400, `unknown schema ${schema}`);
    }
    return {
      content: JSON.stringify(content),
      tokensIn: Math.ceil(user.length / 4),
      tokensOut: 120,
      model: this.model,
    };
  }
}

export function isRetryable(err: unknown): boolean {
  return (
    err instanceof TimeoutError ||
    (err instanceof ProviderError && (err.status === 429 || err.status >= 500))
  );
}
