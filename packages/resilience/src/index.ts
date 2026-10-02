// Small, dependency-free resilience primitives used around every network
// call to something we don't control (GitHub, model providers, webhooks).

export class TimeoutError extends Error {
  constructor(
    readonly ms: number,
    label = 'operation',
  ) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  label?: string,
): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new TimeoutError(ms, label));
    }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type RetryOptions = {
  attempts: number;
  baseMs?: number;
  capMs?: number;
  retryable?: (err: unknown) => boolean;
  /** Server-provided delay (e.g. Retry-After) overrides backoff when present. */
  retryAfterMs?: (err: unknown) => number | undefined;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function retry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      last = err;
      if (attempt === o.attempts || (o.retryable && !o.retryable(err))) break;
      const ceiling = Math.min(o.capMs ?? 10_000, (o.baseMs ?? 250) * 2 ** (attempt - 1));
      const delay = o.retryAfterMs?.(err) ?? Math.floor(Math.random() * ceiling);
      o.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw last;
}

export class CircuitOpenError extends Error {
  constructor(
    readonly name_: string,
    readonly retryInMs: number,
  ) {
    super(`circuit "${name_}" is open; retry in ${retryInMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

export type BreakerState = 'closed' | 'open' | 'half_open';

/**
 * Classic three-state breaker. After `failureThreshold` consecutive failures it
 * opens and fails fast for `cooldownMs`; then one trial call is let through.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  state: BreakerState = 'closed';

  constructor(
    readonly name: string,
    private readonly o: {
      failureThreshold: number;
      cooldownMs: number;
      now?: () => number;
      onStateChange?: (s: BreakerState) => void;
    },
  ) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  private setState(s: BreakerState) {
    if (s !== this.state) {
      this.state = s;
      this.o.onStateChange?.(s);
    }
  }

  async exec<T>(
    fn: () => Promise<T>,
    isFailure: (err: unknown) => boolean = () => true,
  ): Promise<T> {
    if (this.state === 'open') {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.o.cooldownMs)
        throw new CircuitOpenError(this.name, this.o.cooldownMs - elapsed);
      this.setState('half_open');
    }
    if (this.state === 'half_open') {
      if (this.trialInFlight) throw new CircuitOpenError(this.name, this.o.cooldownMs);
      this.trialInFlight = true;
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.setState('closed');
      return result;
    } catch (err) {
      if (isFailure(err)) {
        this.failures++;
        if (this.state === 'half_open' || this.failures >= this.o.failureThreshold) {
          this.openedAt = this.now();
          this.setState('open');
        }
      }
      throw err;
    } finally {
      this.trialInFlight = false;
    }
  }
}

export class BulkheadFullError extends Error {
  constructor(readonly name_: string) {
    super(`bulkhead "${name_}" is full`);
    this.name = 'BulkheadFullError';
  }
}

/** Caps concurrency for one dependency so it can't exhaust the process. */
export class Bulkhead {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    readonly name: string,
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxQueue) throw new BulkheadFullError(this.name);
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  get inFlight() {
    return this.active;
  }
}
