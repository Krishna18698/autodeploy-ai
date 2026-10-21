// Numbers shown on the landing page. Each comes from a reproducible test in
// this repository — see docs/measurements.md for the command behind each.
export const MEASURED = [
  {
    value: 0,
    decimals: 0,
    unit: '',
    label: 'Duplicate job claims',
    detail: '500 jobs raced by 8 workers (integration test)',
  },
  {
    value: 82,
    decimals: 0,
    unit: '%',
    label: 'Failures auto-recovered',
    detail: '38-repo failure corpus · 64% by rules alone · 0 false fixes',
  },
  {
    value: 36,
    decimals: 0,
    unit: 's',
    label: 'Worker killed → rebuild',
    detail: 'SIGKILL mid-build; lease expiry + reaper (chaos test)',
  },
  {
    value: 3.7,
    decimals: 1,
    unit: 'ms',
    label: 'Rollback',
    detail: 'pointer flip under an advisory lock, nothing rebuilt',
  },
] as const;
