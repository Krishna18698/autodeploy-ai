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
