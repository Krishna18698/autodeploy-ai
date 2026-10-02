import { z } from 'zod';

// Every model response is parsed against one of these. A model that returns
// prose, extra fields of the wrong type, or a patch for files it never saw is
// treated as a failed call, not trusted.

export const Classification = z.object({
  category: z.enum([
    'code',
    'dependency',
    'configuration',
    'environment',
    'infrastructure',
    'unknown',
  ]),
  fixable: z.boolean().describe('Whether a small source change could plausibly fix it'),
  reason: z.string().max(400),
});
export type Classification = z.infer<typeof Classification>;

export const Diagnosis = z.object({
  summary: z.string().min(1).max(300).describe('One sentence: what failed'),
  cause: z.string().min(1).max(800).describe('Why it failed, citing the log'),
  filesToRead: z.array(z.string()).max(6).describe('Repo-relative paths needed to write a fix'),
  confidence: z.enum(['low', 'medium', 'high']),
});
export type Diagnosis = z.infer<typeof Diagnosis>;

export const PatchProposal = z.object({
  explanation: z.string().min(1).max(800),
  diff: z
    .string()
    .max(20_000)
    .describe('Unified diff with a/ and b/ prefixes; empty if no safe fix'),
});
export type PatchProposal = z.infer<typeof PatchProposal>;

/** JSON Schema handed to providers that support structured output. */
export function jsonSchemaOf(schema: z.ZodType, name: string) {
  return { name, schema: z.toJSONSchema(schema), strict: true };
}
