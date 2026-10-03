// Scrubs secrets out of build logs before they are stored, streamed or sent
// to a model. Known secret values are replaced exactly; well-known token
// shapes are replaced by pattern as a second line of defence.

const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style keys
  /\bnvapi-[A-Za-z0-9_-]{20,}\b/g, // NVIDIA
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\badp_[A-Za-z0-9_-]{20,}\b/g, // our own API tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  /(\/\/[^:/\s]+:)[^@/\s]{3,}(@)/g, // credentials in URLs
];

export type Redactor = (line: string) => string;

export function createRedactor(secretValues: Iterable<string>): Redactor {
  // Longest first so a secret that contains another is replaced whole.
  const values = [...new Set(secretValues)]
    .filter((v) => v.length >= 6)
    .sort((a, b) => b.length - a.length);
  return (line) => {
    let out = line;
    for (const v of values) {
      if (out.includes(v)) out = out.split(v).join('[redacted]');
    }
    for (const re of TOKEN_PATTERNS) {
      // Only the URL-credentials pattern has capture groups; for the others the
      // callback's extra arguments are (offset, input), which must never be echoed.
      out = out.replace(re, (_m: string, pre: unknown, post: unknown) =>
        typeof pre === 'string' && typeof post === 'string'
          ? `${pre}[redacted]${post}`
          : '[redacted]',
      );
    }
    return out;
  };
}
