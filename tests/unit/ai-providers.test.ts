import { afterEach, describe, expect, it, vi } from 'vitest';
import { nvidia, workersAi } from '../../packages/ai/src/providers';

const schema = {
  name: 'diagnosis',
  strict: true,
  schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
};

function stubReply(content: unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
      );
    }),
  );
  return bodies;
}

describe('structured answers per provider', () => {
  afterEach(() => vi.unstubAllGlobals());
  const req = {
    messages: [{ role: 'user' as const, content: 'x' }],
    maxTokens: 100,
    jsonSchema: schema,
  };

  it('sends Workers AI the bare schema (it ignores the OpenAI envelope) and accepts a parsed answer', async () => {
    const bodies = stubReply({ summary: 'ok' });
    const res = await workersAi('acct', 'token', '@cf/openai/gpt-oss-120b', 'cloudflare').chat(req);
    expect(bodies[0]?.response_format).toEqual({ type: 'json_schema', json_schema: schema.schema });
    expect(JSON.parse(res.content)).toEqual({ summary: 'ok' });
  });

  it('keeps the OpenAI envelope for OpenAI-style providers', async () => {
    const bodies = stubReply('{"summary":"ok"}');
    const res = await nvidia('key', 'nvidia/model').chat(req);
    expect(bodies[0]?.response_format).toEqual({ type: 'json_schema', json_schema: schema });
    expect(res.content).toBe('{"summary":"ok"}');
  });
});
