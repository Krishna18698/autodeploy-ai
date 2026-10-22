import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/**
 * The visitor's address, for per-IP rate limits and the audit log. Public
 * requests reach the API through Cloudflare's tunnel and Caddy, so `req.ip`
 * is the Docker gateway for everyone; Cloudflare's CF-Connecting-IP is the
 * real client, and Cloudflare overwrites any value a client sends. Requests
 * from inside the VM (the worker, health checks) don't carry it.
 */
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers['cf-connecting-ip'];
  return typeof cf === 'string' && isIP(cf) ? cf : req.ip;
}
