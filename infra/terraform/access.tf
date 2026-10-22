# A second check in front of SSH (audit 2026-10-22, #14). The tunnel's ssh.
# hostnames only answer someone signed in to Cloudflare Access as the owner
# (a one-time code to their email, good for a day) or the GitHub Actions
# deploy with its service token. A stolen SSH key alone no longer reaches the
# VM, and nobody else even gets to its SSH server. api., run. and sites stay
# as they are.
#
# Needs Zero Trust enabled on the account, and the Terraform token allowed
# Access: Apps and Policies, Service Tokens, and Organizations, Identity
# Providers and Groups (Edit).

variable "access_owner_email" {
  type        = string
  description = "Who may SSH to the VM (Cloudflare Access emails them a one-time code)."
}

resource "cloudflare_zero_trust_access_service_token" "deploy" {
  account_id = var.cloudflare_account_id
  name       = "github-actions-deploy"
  # Renew before it lapses (issues-to-fix lists the date): deploys stop at expiry.
  duration = "8760h"
}

resource "cloudflare_zero_trust_access_policy" "owner" {
  account_id = var.cloudflare_account_id
  name       = "Owner, by email code"
  decision   = "allow"
  include    = [{ email = { email = var.access_owner_email } }]
}

resource "cloudflare_zero_trust_access_policy" "deploy" {
  account_id = var.cloudflare_account_id
  name       = "GitHub Actions deploy"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = cloudflare_zero_trust_access_service_token.deploy.id } }]
}

# Every ssh. hostname the tunnel serves, so an older domain is no way around it.
resource "cloudflare_zero_trust_access_application" "ssh" {
  for_each             = toset(local.domains)
  account_id           = var.cloudflare_account_id
  name                 = "SSH (${each.key})"
  type                 = "self_hosted"
  domain               = "ssh.${each.key}"
  session_duration     = "24h"
  app_launcher_visible = false
  policies = [
    { id = cloudflare_zero_trust_access_policy.owner.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.deploy.id, precedence = 2 },
  ]
}

output "deploy_access_client_id" { value = cloudflare_zero_trust_access_service_token.deploy.client_id }
output "deploy_access_client_secret" {
  value     = cloudflare_zero_trust_access_service_token.deploy.client_secret
  sensitive = true
}
