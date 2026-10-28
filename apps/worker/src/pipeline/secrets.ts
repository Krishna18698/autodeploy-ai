import type { Keyring } from '@autodeploy/crypto';
import { loadProjectSecrets, type Sql } from '@autodeploy/db';

/** A project's env vars, decrypted (builds and SSR runtimes; never logged). */
export function loadSecrets(
  deps: { sql: Sql; keyring: Keyring },
  projectId: string,
): Promise<Record<string, string>> {
  return loadProjectSecrets(deps.sql, deps.keyring, projectId);
}
