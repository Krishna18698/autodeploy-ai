import { bytes, duration } from './format';

const HEX = /^[0-9a-f]+$/;
/** camelCase or snake_case → plain words: buildMs → "build", commitSha → "commit". */
const label = (key: string) =>
  key
    .replace(/(Ms|Sha|Sha256)$/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase() || key.toLowerCase();

function value(key: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') {
    if (/Ms$/.test(key)) return duration(v);
    if (/bytes$/i.test(key)) return bytes(v);
    return v.toLocaleString();
  }
  if (typeof v === 'string') {
    // A content hash or a commit: enough of it to recognise.
    if (v.length >= 40 && HEX.test(v)) return `${v.slice(0, v.length === 40 ? 7 : 8)}…`;
    return v.length > 160 ? `${v.slice(0, 160)}…` : v;
  }
  if (Array.isArray(v)) {
    const shown = v.slice(0, 8).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)));
    return shown.join(', ') + (v.length > 8 ? ` and ${v.length - 8} more` : '');
  }
  if (v && typeof v === 'object')
    return Object.entries(v)
      .filter(([, x]) => x !== null && x !== '' && typeof x !== 'object')
      .map(([k, x]) => `${label(k)} ${value(k, x)}`)
      .join(', ');
  return String(v);
}

/**
 * A timeline event's details as short readable pairs ("build: 1m 46s",
 * "missing: A, B and 3 more") instead of raw JSON, which ran off the page.
 */
export function eventDetails(
  payload: Record<string, unknown>,
): Array<{ key: string; text: string }> {
  return Object.entries(payload)
    .filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
    .slice(0, 8)
    .map(([k, v]) => ({ key: label(k), text: value(k, v) }))
    .filter((d) => d.text !== '');
}
