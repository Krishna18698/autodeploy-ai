// Site hostnames are always one label deep under the platform domain so the
// free wildcard certificate covers them:
//   shop.<domain>          production
//   pr-42--shop.<domain>   preview for pull request 42
//   d128--shop.<domain>    one specific deployment (immutable)

export const RESERVED_LABELS = new Set(['app', 'api', 'www', 'docs', 'status', 'admin', 'mail']);

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export type SiteRoute =
  | { kind: 'production'; slug: string }
  | { kind: 'preview'; slug: string; pr: number }
  | { kind: 'deployment'; slug: string; number: number };

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes('--') && !RESERVED_LABELS.has(slug);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
}

export function parseSiteHost(host: string, platformDomain: string): SiteRoute | undefined {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  const suffix = `.${platformDomain.toLowerCase()}`;
  if (!h.endsWith(suffix)) return undefined;
  const label = h.slice(0, -suffix.length);
  if (label.includes('.') || RESERVED_LABELS.has(label)) return undefined;
  const preview = /^pr-(\d{1,6})--(.+)$/.exec(label);
  if (preview?.[1] && preview[2] && isValidSlug(preview[2])) {
    return { kind: 'preview', slug: preview[2], pr: Number(preview[1]) };
  }
  const pinned = /^d(\d{1,7})--(.+)$/.exec(label);
  if (pinned?.[1] && pinned[2] && isValidSlug(pinned[2])) {
    return { kind: 'deployment', slug: pinned[2], number: Number(pinned[1]) };
  }
  return isValidSlug(label) ? { kind: 'production', slug: label } : undefined;
}

export function siteHost(route: SiteRoute, platformDomain: string): string {
  switch (route.kind) {
    case 'production':
      return `${route.slug}.${platformDomain}`;
    case 'preview':
      return `pr-${route.pr}--${route.slug}.${platformDomain}`;
    case 'deployment':
      return `d${route.number}--${route.slug}.${platformDomain}`;
  }
}

/** Key used in the edge route store (KV) for a route. */
export function routeKey(route: SiteRoute): string {
  switch (route.kind) {
    case 'production':
      return `route:${route.slug}`;
    case 'preview':
      return `route:pr-${route.pr}--${route.slug}`;
    case 'deployment':
      return `route:d${route.number}--${route.slug}`;
  }
}
