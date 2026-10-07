# DNS + tunnel + edge routing for the platform domain.
#   app.<domain>  → Vercel (dashboard)
#   api.<domain>  → Cloudflare Tunnel → Caddy → API replicas
#   *.<domain>    → the edge router Worker (user sites)

data "cloudflare_zone" "platform" {
  filter = { name = var.platform_domain }
}

resource "random_password" "tunnel_secret" {
  length  = 48
  special = false
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "api" {
  account_id    = var.cloudflare_account_id
  name          = "autodeploy-api"
  tunnel_secret = base64encode(random_password.tunnel_secret.result)
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "api" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.api.id
  config = {
    # cloudflared runs on the VM host (systemd), not in Compose, so SSH keeps
    # working even when the stack is down.
    ingress = [
      { hostname = "api.${var.platform_domain}", service = "http://localhost:8080" },
      { hostname = "ssh.${var.platform_domain}", service = "ssh://localhost:22" },
      # SSR runtime gateway (ADR 0008); it rejects anything without the internal token.
      { hostname = "run.${var.platform_domain}", service = "http://localhost:8082" },
      { service = "http_status:404" },
    ]
  }
}

resource "cloudflare_dns_record" "api" {
  zone_id = data.cloudflare_zone.platform.zone_id
  name    = "api"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.api.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "run" {
  zone_id = data.cloudflare_zone.platform.zone_id
  name    = "run"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.api.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "ssh" {
  zone_id = data.cloudflare_zone.platform.zone_id
  name    = "ssh"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.api.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

# The dashboard: served by the edge Worker (pages from Vercel, /api and /auth
# from the API). Vercel can't attach a subdomain of dpdns.org itself (it treats
# dpdns.org as another account's apex), so the record only needs to be proxied.
resource "cloudflare_dns_record" "app" {
  zone_id = data.cloudflare_zone.platform.zone_id
  name    = "app"
  type    = "AAAA"
  content = "100::" # discard prefix: the Worker answers, there is no origin
  proxied = true
  ttl     = 1
}

# Proxied wildcard so every <slug>.<domain> reaches the Worker route below.
resource "cloudflare_dns_record" "sites" {
  zone_id = data.cloudflare_zone.platform.zone_id
  name    = "*"
  type    = "AAAA"
  content = "100::" # discard prefix: the Worker answers, there is no origin
  proxied = true
  ttl     = 1
}

resource "cloudflare_workers_kv_namespace" "routes" {
  account_id = var.cloudflare_account_id
  title      = "autodeploy-routes"
}

resource "cloudflare_workers_route" "sites" {
  zone_id = data.cloudflare_zone.platform.zone_id
  pattern = "*.${var.platform_domain}/*"
  script  = "autodeploy-edge"
}

# api and ssh go straight to the tunnel: more specific routes with no Worker
# win over the wildcard, so they don't spend the free 100k Worker requests/day
# (and SSH's WebSocket never passes through site-serving code).
resource "cloudflare_workers_route" "bypass" {
  for_each = toset(["api", "ssh", "run"])
  zone_id  = data.cloudflare_zone.platform.zone_id
  pattern  = "${each.key}.${var.platform_domain}/*"
}

output "kv_namespace_id" { value = cloudflare_workers_kv_namespace.routes.id }
output "tunnel_id" { value = cloudflare_zero_trust_tunnel_cloudflared.api.id }
