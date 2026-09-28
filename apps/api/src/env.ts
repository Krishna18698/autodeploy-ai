import { z } from 'zod';

// Parsed once at boot: a missing or malformed variable stops the process
// before it accepts traffic, instead of failing on the first request.
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  PLATFORM_DOMAIN: z.string().min(1),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  VALKEY_URL: z.url({ protocol: /^rediss?$/ }),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}`);
  }
  return parsed.data;
}
