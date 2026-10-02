// Numbers shown on the landing page. Each one comes from a measurement in
// this repository (see docs/measurements.md); update them from the Phase 12
// test reports rather than by hand-waving.
export const MEASURED = [
  { value: 11.7, decimals: 1, unit: 'ms', label: 'rollback', detail: 'pointer flip, no rebuild' },
  {
    value: 0,
    decimals: 0,
    unit: '',
    label: 'duplicate side effects',
    detail: 'after at-least-once redelivery of every event',
  },
  {
    value: 3,
    decimals: 0,
    unit: '/3',
    label: 'failure fixtures recovered',
    detail: '2 by rules, 1 by AI with approval',
  },
  {
    value: 550,
    decimals: 0,
    unit: 'ms',
    label: 'analytics rebuilt from Kafka',
    detail: '72 events replayed into 5 rows',
  },
] as const;
