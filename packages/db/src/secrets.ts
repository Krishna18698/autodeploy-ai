import { decrypt, type Keyring } from '@autodeploy/crypto';
import type { Sql } from './client.js';

/**
 * A project's environment variables, decrypted: for its builds (the sandbox,
 * or GitHub Actions through the API) and its server-rendered runtime. Never
 * logged. One implementation, so every reader decrypts with the same context.
 */
export async function loadProjectSecrets(
  sql: Sql,
  keyring: Keyring,
  projectId: string,
): Promise<Record<string, string>> {
  const rows = await sql<
    { key: string; ciphertext: Buffer; dek_ciphertext: Buffer; key_version: number }[]
  >`
    select key, ciphertext, dek_ciphertext, key_version from env_vars where project_id = ${projectId}`;
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.key] = decrypt(
      keyring,
      { ciphertext: r.ciphertext, dekCiphertext: r.dek_ciphertext, keyVersion: r.key_version },
      `env:${projectId}:${r.key}`,
    );
  }
  return out;
}
