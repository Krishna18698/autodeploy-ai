import type { CookieFacts, CookieMemory } from '@autodeploy/core';
import type { Sql } from '@autodeploy/db';
import type { Logger } from '@autodeploy/telemetry';

// What each project's server is known to do with its cookie names (see
// packages/core/src/site-cookies.ts): loaded once per project, then kept up to
// date from the app's own Set-Cookie headers. Only changes are written, one
// write at a time per project, and at most MAX_COOKIE_NAMES names are kept, so
// an app minting a new name per visitor can't grow it without end.

export const MAX_COOKIE_NAMES = 32;
const MAX_NAME_LENGTH = 128;
const MAX_PROJECTS = 2_000;

export class SiteCookieMemory {
  private readonly known = new Map<string, Map<string, CookieFacts>>();
  private readonly loading = new Map<string, Promise<Map<string, CookieFacts>>>();
  private readonly writing = new Map<string, Promise<void>>();

  constructor(
    private readonly sql: Sql,
    private readonly log: Pick<Logger, 'warn'>,
  ) {}

  /** The project's memory. A database failure gives an empty one: the site stays up. */
  async get(projectId: string): Promise<CookieMemory> {
    const hit = this.known.get(projectId);
    if (hit) return hit;
    let pending = this.loading.get(projectId);
    if (!pending) {
      pending = this.load(projectId).finally(() => this.loading.delete(projectId));
      this.loading.set(projectId, pending);
    }
    try {
      return await pending;
    } catch (err) {
      this.log.warn({ err, projectId }, 'cookie memory unavailable');
      return new Map();
    }
  }

  private async load(projectId: string) {
    const rows = await this.sql<
      { name: string; protect: boolean; same_site: CookieFacts['sameSite'] }[]
    >`select name, protect, same_site from site_cookies where project_id = ${projectId}`;
    const memory = new Map(
      rows.map((r) => [r.name, { protect: r.protect, sameSite: r.same_site }]),
    );
    if (this.known.size >= MAX_PROJECTS) this.known.clear();
    this.known.set(projectId, memory);
    return memory;
  }

  /** Records what the app just set; returns once it's written (callers needn't wait). */
  learn(
    projectId: string,
    orgId: string,
    learned: ReadonlyMap<string, CookieFacts>,
  ): Promise<void> {
    const memory = this.known.get(projectId);
    // Never loaded (the database was down): nothing to compare with.
    if (!memory) return Promise.resolve();
    const changed: { name: string; facts: CookieFacts }[] = [];
    for (const [name, facts] of learned) {
      const was = memory.get(name);
      if (was && was.protect === facts.protect && was.sameSite === facts.sameSite) continue;
      if (!was && (memory.size >= MAX_COOKIE_NAMES || name.length > MAX_NAME_LENGTH)) continue;
      memory.set(name, facts);
      changed.push({ name, facts });
    }
    if (!changed.length) return this.writing.get(projectId) ?? Promise.resolve();
    // In order, so the last thing the app said is what the database keeps.
    const next = (this.writing.get(projectId) ?? Promise.resolve()).then(async () => {
      for (const { name, facts } of changed)
        await this.sql`
          insert into site_cookies (project_id, org_id, name, protect, same_site)
          values (${projectId}, ${orgId}, ${name}, ${facts.protect}, ${facts.sameSite})
          on conflict (project_id, name) do update
            set protect = excluded.protect, same_site = excluded.same_site, updated_at = now()`;
    });
    const settled = next.catch((err) => {
      this.log.warn({ err, projectId }, 'cookie memory write failed');
    });
    this.writing.set(projectId, settled);
    void settled.finally(() => {
      if (this.writing.get(projectId) === settled) this.writing.delete(projectId);
    });
    return settled;
  }
}
