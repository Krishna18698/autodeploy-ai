import { isIP } from 'node:net';
import { runProcess } from './sandbox.js';

// gVisor containers can't use Docker's embedded DNS (127.0.0.11): its own
// network stack never reaches it, so "http://egress:3128" fails with
// EAI_AGAIN and every build under runsc died in npm install. They don't need
// DNS otherwise (the proxy resolves registry names), so hand them the proxy's
// IP on its network instead, looked up just before the container starts.

const cache = new Map<string, { url: string; at: number }>();

export async function proxyByAddress(proxyUrl: string, network: string): Promise<string> {
  const u = new URL(proxyUrl);
  if (isIP(u.hostname)) return proxyUrl;
  const key = `${network}|${proxyUrl}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.url;
  const out: string[] = [];
  const code = await runProcess(
    'docker',
    [
      'network',
      'inspect',
      network,
      '-f',
      '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\\n"}}{{end}}',
    ],
    (l) => out.push(l),
  );
  // Compose names the service container <project>-<service>-<n>.
  const re = new RegExp(`(^|[-_])${u.hostname}([-_]\\d+)?$`);
  const ip =
    code === 0
      ? out
          .map((l) => l.trim().split(' '))
          .find(([name]) => name && re.test(name))?.[1]
          ?.split('/')[0]
      : undefined;
  if (!ip) return proxyUrl; // not found: fall back to the name (works under runc)
  u.hostname = ip;
  const url = u.toString().replace(/\/$/, '');
  cache.set(key, { url, at: Date.now() });
  return url;
}
