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

// Edits, not a diff: models copy text reliably but mangle diff formatting (lost
// line breaks, wrong hunk counts). AutoDeploy computes the real diff from them.
export const PatchProposal = z.object({
  explanation: z.string().min(1).max(800),
  edits: z
    .array(
      z.object({
        path: z.string().min(1).max(300).describe('Repo-relative path of a file shown above'),
        find: z
          .string()
          .max(4000)
          .describe('Exact text now in the file, copied verbatim, long enough to occur once'),
        replace: z.string().max(4000).describe('What the found text becomes'),
      }),
    )
    .max(10)
    .describe('Empty when there is no safe fix'),
});
export type PatchProposal = z.infer<typeof PatchProposal>;

/** JSON Schema handed to providers that support structured output. */
export function jsonSchemaOf(schema: z.ZodType, name: string) {
  return { name, schema: z.toJSONSchema(schema), strict: true };
}
