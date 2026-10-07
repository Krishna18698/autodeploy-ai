import { decrypt, type Keyring } from '@autodeploy/crypto';
import type { Sql } from '@autodeploy/db';

/** A project's env vars, decrypted (builds and SSR runtimes; never logged). */
export async function loadSecrets(
  deps: { sql: Sql; keyring: Keyring },
  projectId: string,
): Promise<Record<string, string>> {
  const rows = await deps.sql<
    { key: string; ciphertext: Buffer; dek_ciphertext: Buffer; key_version: number }[]
  >`
    select key, ciphertext, dek_ciphertext, key_version from env_vars where project_id = ${projectId}`;
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.key] = decrypt(
      deps.keyring,
      { ciphertext: r.ciphertext, dekCiphertext: r.dek_ciphertext, keyVersion: r.key_version },
      `env:${projectId}:${r.key}`,
    );
  }
  return out;
}
