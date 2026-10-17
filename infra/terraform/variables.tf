variable "oci_tenancy_ocid" { type = string }
variable "oci_user_ocid" { type = string }
variable "oci_fingerprint" { type = string }
variable "oci_private_key_path" { type = string }
variable "oci_region" {
  type    = string
  default = "ap-mumbai-1"
}
variable "oci_compartment_ocid" { type = string }
variable "ssh_public_key" {
  type        = string
  description = "Only used via the Cloudflare Tunnel (cloudflared access ssh); no port 22 is opened."
}

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}
variable "cloudflare_account_id" { type = string }
variable "platform_domain" {
  type        = string
  description = "e.g. autodeploy.eu.org — must already be a zone in Cloudflare"
}

variable "bootstrap_ssh_cidr" {
  type        = string
  default     = ""
  description = "Your IP as a.b.c.d/32 during first VM setup only; empty = no inbound SSH."
}

# Always Free allows up to 2 OCPU / 12 GB of A1 in total. If Oracle keeps
# reporting "Out of host capacity", 1 / 6 is easier to get (pair it with
# SMALL=1 for ship.sh).
variable "vm_ocpus" {
  type    = number
  default = 2
}
variable "vm_memory_gb" {
  type    = number
  default = 12
}

variable "email_dns_records" {
  description = "DNS records Resend needs to send from the platform domain (written by scripts/resend-domain.ts)"
  type = list(object({
    type     = string
    name     = string
    content  = string
    priority = optional(number)
  }))
  default = []
}
