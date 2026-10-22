import { parseRepoUrl } from '@autodeploy/github';
import { describe, expect, it } from 'vitest';

describe('reading a GitHub repository URL', () => {
  it.each([
    [
      'https://github.com/Krishna18698/portfolio-ai',
      { owner: 'Krishna18698', repo: 'portfolio-ai' },
    ],
    ['github.com/acme/site.git', { owner: 'acme', repo: 'site' }],
    ['https://github.com/acme/.github', { owner: 'acme', repo: '.github' }],
  ])('%s', (url, ref) => {
    expect(parseRepoUrl(url)).toEqual(ref);
  });

  it.each([
    'https://github.com/../user',
    'https://github.com/acme/..',
    'https://github.com/acme/.',
    'https://github.com/a.b/repo',
    'https://evil.example/acme/site',
  ])('refuses %s', (url) => {
    expect(() => parseRepoUrl(url)).toThrow();
  });
});
