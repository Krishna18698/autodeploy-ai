// Just enough semver to answer "which supported Node major satisfies this
// range?" without pulling a dependency into the pure domain package.

export type Version = [number, number, number];

export function parseVersion(input: string): Version | undefined {
  const m = /^\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(input);
  if (!m) return undefined;
  const n = (s: string | undefined) => (s === undefined || s === 'x' || s === '*' ? 0 : Number(s));
  return [Number(m[1]), n(m[2]), n(m[3])];
}

function cmp(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function satisfiesComparator(v: Version, comp: string): boolean {
  const c = comp.trim();
  if (c === '' || c === '*' || c === 'x' || c === 'latest') return true;
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(c);
  if (!m) return false;
  const op = m[1] ?? '';
  const raw = m[2] ?? '';
  const target = parseVersion(raw);
  if (!target) return false;
  const parts = raw.replace(/^v/, '').split('.');
  const wildcardMinor = parts.length < 2 || parts[1] === 'x' || parts[1] === '*';
  const wildcardPatch = parts.length < 3 || parts[2] === 'x' || parts[2] === '*';
  switch (op) {
    case '>=':
      return cmp(v, target) >= 0;
    case '>':
      return cmp(v, target) > 0;
    case '<=':
      return cmp(v, target) <= 0;
    case '<':
      return cmp(v, target) < 0;
    case '^':
      return cmp(v, target) >= 0 && v[0] === target[0];
    case '~':
      return cmp(v, target) >= 0 && v[0] === target[0] && (wildcardMinor || v[1] === target[1]);
    default:
      // Bare "20" or "20.x" means the whole major (or minor).
      if (wildcardMinor) return v[0] === target[0];
      if (wildcardPatch) return v[0] === target[0] && v[1] === target[1];
      return cmp(v, target) === 0;
  }
}

/** Supports `||`, space-separated AND sets, and `a - b` hyphen ranges. */
export function satisfies(version: Version, range: string): boolean {
  return range.split('||').some((set) => {
    const hyphen = /^\s*([\w.*]+)\s+-\s+([\w.*]+)\s*$/.exec(set);
    if (hyphen?.[1] && hyphen[2]) {
      return (
        satisfiesComparator(version, `>=${hyphen[1]}`) &&
        satisfiesComparator(version, `<=${hyphen[2]}`)
      );
    }
    const comparators = set
      .trim()
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
      .split(/\s+/);
    return comparators.every((c) => satisfiesComparator(version, c));
  });
}

/**
 * Highest major in `supported` whose latest release line satisfies `range`.
 * Each supported major is checked as `major.99.99` and `major.0.0` so both
 * ">=20.19" and "<21" style ranges resolve sensibly.
 */
export function pickMajor(range: string, supported: readonly number[]): number | undefined {
  const sorted = [...supported].sort((a, b) => b - a);
  return sorted.find(
    (major) => satisfies([major, 99, 99], range) || satisfies([major, 0, 0], range),
  );
}
