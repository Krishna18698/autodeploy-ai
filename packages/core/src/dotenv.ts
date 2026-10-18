// Parses a .env file pasted or uploaded into a project's Environment tab.
// Follows the common dotenv rules: comments, `export KEY=…`, single and double
// quotes (double quotes may span lines and understand \n), and `#` comments
// after unquoted values. Lines it can't use are reported, never guessed at.

export type DotenvResult = {
  vars: { key: string; value: string }[];
  skipped: { line: number; reason: string }[];
};

const KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_VALUE = 8192;

/** Index of the first unescaped double quote, or -1. */
function closingQuote(s: string): number {
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\') k++;
    else if (s[k] === '"') return k;
  }
  return -1;
}

export function parseDotenv(text: string): DotenvResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const found = new Map<string, string>();
  const skipped: DotenvResult['skipped'] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      skipped.push({ line: lineNo, reason: 'not KEY=value' });
      continue;
    }
    const key = m[1] ?? '';
    let rest = m[2] ?? '';
    let value: string;
    if (rest.startsWith('"')) {
      // Double quotes: may continue over several lines; \n \t \" \\ are escapes.
      const startLine = i;
      let body = rest.slice(1);
      let end = closingQuote(body);
      while (end < 0 && i + 1 < lines.length) {
        body += `\n${lines[++i]}`;
        end = closingQuote(body);
      }
      if (end < 0) {
        skipped.push({ line: lineNo, reason: 'unclosed double quote' });
        i = startLine; // the following lines are still read as their own entries
        continue;
      }
      value = body
        .slice(0, end)
        .replace(/\\([nt"\\])/g, (_, c: string) => ({ n: '\n', t: '\t' })[c] ?? c);
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) {
        skipped.push({ line: lineNo, reason: 'unclosed single quote' });
        continue;
      }
      value = rest.slice(1, end);
    } else {
      rest = rest.replace(/\s+#.*$/, '');
      value = rest.trim();
    }
    if (!KEY.test(key)) {
      skipped.push({ line: lineNo, reason: `${key.slice(0, 40)} is not UPPER_SNAKE_CASE` });
      continue;
    }
    if (value.length > MAX_VALUE) {
      skipped.push({ line: lineNo, reason: `${key} is longer than ${MAX_VALUE} characters` });
      continue;
    }
    found.set(key, value); // a repeated key: the last one wins, as in dotenv
  }
  return { vars: [...found].map(([key, value]) => ({ key, value })), skipped };
}
