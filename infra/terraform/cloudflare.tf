# DNS + tunnel + edge routing for the platform domain.
#   <domain>, www.<domain>  → the edge Worker (redirects to the dashboard)
#   app.<domain>  → the edge Worker (pages from Vercel, /api and /auth from the API)
#   api.<domain>  → Cloudflare Tunnel → Caddy → API replicas
#   *.<domain>    → the edge Worker (user sites)
#
# legacy_domains (earlier platform domains) keep the same records so their
# addresses keep resolving; the Worker redirects them to platform_domain, and
# api/ssh/run on them still reach the VM until nothing points there any more.

locals {
  domains = concat([var.platform_domain], var.legacy_domains)
  tunnel_hosts = flatten([
    for d in local.domains : [
      { hostname = "api.${d}", service = "http://localhost:8080" },
      { hostname = "ssh.${d}", service = "ssh://localhost:22" },
      # SSR runtime gateway (ADR 0008); it rejects anything without the internal token.
      { hostname = "run.${d}", service = "http://localhost:8082" },
    ]
  ])
  bypass = { for p in setproduct(local.domains, ["api", "ssh", "run"]) : "${p[1]}.${p[0]}" => p[0] }
}

data "cloudflare_zone" "platform" {
  for_each = toset(local.domains)
  filter   = { name = each.key }
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
    ingress = concat(local.tunnel_hosts, [{ service = "http_status:404" }])
  }
}

resource "cloudflare_dns_record" "tunnel" {
  for_each = { for h in local.tunnel_hosts : h.hostname => h }
  zone_id  = data.cloudflare_zone.platform[regex("^[a-z]+\\.(.+)$", each.key)[0]].zone_id
  name     = each.key
  type     = "CNAME"
  content  = "${cloudflare_zero_trust_tunnel_cloudflared.api.id}.cfargotunnel.com"
  proxied  = true
  ttl      = 1
}

# Hostnames the Worker answers itself: proxied records pointing at the discard
# prefix (there is no origin). Vercel isn't attached to the domain; the Worker
# fetches dashboard pages from it, so the browser only ever sees app.<domain>.
resource "cloudflare_dns_record" "app" {
  for_each = toset(local.domains)
  zone_id  = data.cloudflare_zone.platform[each.key].zone_id
  name     = "app.${each.key}"
  type     = "AAAA"
  content  = "100::"
  proxied  = true
  ttl      = 1
}

# Proxied wildcard so every <slug>.<domain> reaches the Worker route below.
resource "cloudflare_dns_record" "sites" {
  for_each = toset(local.domains)
  zone_id  = data.cloudflare_zone.platform[each.key].zone_id
  name     = "*.${each.key}"
  type     = "AAAA"
  content  = "100::"
  proxied  = true
  ttl      = 1
}

# The bare domain (only the current one; a legacy domain may not be ours at the apex).
resource "cloudflare_dns_record" "apex" {
  zone_id = data.cloudflare_zone.platform[var.platform_domain].zone_id
  name    = var.platform_domain
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
}

resource "cloudflare_workers_kv_namespace" "routes" {
  account_id = var.cloudflare_account_id
  title      = "autodeploy-routes"
}

resource "cloudflare_workers_route" "sites" {
  for_each = toset(local.domains)
  zone_id  = data.cloudflare_zone.platform[each.key].zone_id
  pattern  = "*.${each.key}/*"
  script   = "autodeploy-edge"
}

resource "cloudflare_workers_route" "apex" {
  zone_id = data.cloudflare_zone.platform[var.platform_domain].zone_id
  pattern = "${var.platform_domain}/*"
  script  = "autodeploy-edge"
}

# api, ssh and run go straight to the tunnel: more specific routes with no
# Worker win over the wildcard, so they don't spend the free 100k Worker
# requests/day (and SSH's WebSocket never passes through site-serving code).
resource "cloudflare_workers_route" "bypass" {
  for_each = local.bypass
  zone_id  = data.cloudflare_zone.platform[each.value].zone_id
  pattern  = "${each.key}/*"
}

output "kv_namespace_id" { value = cloudflare_workers_kv_namespace.routes.id }
output "tunnel_id" { value = cloudflare_zero_trust_tunnel_cloudflared.api.id }

# Email sending (Resend): SPF, bounce and DKIM records for the platform domain.
# scripts/resend-domain.ts fetches them from Resend into email.auto.tfvars.json;
# until then the list is empty and nothing is created.
resource "cloudflare_dns_record" "email" {
  for_each = { for r in var.email_dns_records : "${r.type}:${r.name}" => r }
  zone_id  = data.cloudflare_zone.platform[var.platform_domain].zone_id
  name     = each.value.name
  type     = each.value.type
  content  = each.value.content
  priority = each.value.priority
  proxied  = false
  ttl      = 1
}

# Mail claiming to be from the domain but failing SPF/DKIM is reported, not yet
# rejected; tighten to quarantine once Resend has been sending cleanly for a while.
resource "cloudflare_dns_record" "dmarc" {
  zone_id = data.cloudflare_zone.platform[var.platform_domain].zone_id
  name    = "_dmarc.${var.platform_domain}"
  type    = "TXT"
  content = "\"v=DMARC1; p=none;\""
  ttl     = 1
}

# Resources that existed before domains became a list: same objects, new
# addresses, so the move to for_each changes nothing in Cloudflare.
moved {
  from = cloudflare_dns_record.api
  to   = cloudflare_dns_record.tunnel["api.autodeploy.dpdns.org"]
}
moved {
  from = cloudflare_dns_record.ssh
  to   = cloudflare_dns_record.tunnel["ssh.autodeploy.dpdns.org"]
}
moved {
  from = cloudflare_dns_record.run
  to   = cloudflare_dns_record.tunnel["run.autodeploy.dpdns.org"]
}
moved {
  from = cloudflare_dns_record.app
  to   = cloudflare_dns_record.app["autodeploy.dpdns.org"]
}
moved {
  from = cloudflare_dns_record.sites
  to   = cloudflare_dns_record.sites["autodeploy.dpdns.org"]
}
moved {
  from = cloudflare_workers_route.sites
  to   = cloudflare_workers_route.sites["autodeploy.dpdns.org"]
}
moved {
  from = cloudflare_workers_route.bypass["api"]
  to   = cloudflare_workers_route.bypass["api.autodeploy.dpdns.org"]
}
moved {
  from = cloudflare_workers_route.bypass["ssh"]
  to   = cloudflare_workers_route.bypass["ssh.autodeploy.dpdns.org"]
}
moved {
  from = cloudflare_workers_route.bypass["run"]
  to   = cloudflare_workers_route.bypass["run.autodeploy.dpdns.org"]
}
