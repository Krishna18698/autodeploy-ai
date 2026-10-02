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
    ingress = [
      { hostname = "api.${var.platform_domain}", service = "http://caddy:8080" },
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

resource "cloudflare_dns_record" "app" {
  zone_id = data.cloudflare_zone.platform.zone_id
  name    = "app"
  type    = "CNAME"
  content = "cname.vercel-dns.com"
  proxied = false
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

output "kv_namespace_id" { value = cloudflare_workers_kv_namespace.routes.id }
output "tunnel_id" { value = cloudflare_zero_trust_tunnel_cloudflared.api.id }
