import { parseDotenv } from '@autodeploy/core';
import { describe, expect, it } from 'vitest';

describe('importing a .env file', () => {
  it('reads the usual dotenv forms', () => {
    const r = parseDotenv(
      [
        '# comment',
        '',
        'PLAIN=hello',
        'SPACED = spaced value ',
        'export EXPORTED=yes',
        'INLINE=abc # trailing comment',
        'HASH_IN_VALUE=abc#def',
        'EMPTY=',
        "SINGLE='raw $NOT \\n escaped'",
        'DOUBLE="line1\\nline2 \\"quoted\\""',
        'PEM="-----BEGIN KEY-----',
        'abc123',
        '-----END KEY-----"',
        'PLAIN=last wins',
      ].join('\n'),
    );
    expect(Object.fromEntries(r.vars.map((v) => [v.key, v.value]))).toEqual({
      PLAIN: 'last wins',
      SPACED: 'spaced value',
      EXPORTED: 'yes',
      INLINE: 'abc',
      HASH_IN_VALUE: 'abc#def',
      EMPTY: '',
      SINGLE: 'raw $NOT \\n escaped',
      DOUBLE: 'line1\nline2 "quoted"',
      PEM: '-----BEGIN KEY-----\nabc123\n-----END KEY-----',
    });
    expect(r.skipped).toEqual([]);
  });

  it('reports lines it cannot use instead of guessing', () => {
    const r = parseDotenv(
      ['lower_case=1', 'NO_EQUALS', 'BROKEN="never closed', 'AFTER=still read', 'CRLF=ok\r'].join(
        '\n',
      ),
    );
    expect(r.vars).toEqual([
      { key: 'AFTER', value: 'still read' },
      { key: 'CRLF', value: 'ok' },
    ]);
    expect(r.skipped).toEqual([
      { line: 1, reason: 'lower_case is not UPPER_SNAKE_CASE' },
      { line: 2, reason: 'not KEY=value' },
      { line: 3, reason: 'unclosed double quote' },
    ]);
  });
});
