# Copy to terraform.tfvars (git-ignored) and fill in. Never commit real values.
oci_tenancy_ocid      = "ocid1.tenancy.oc1..xxxx"
oci_user_ocid         = "ocid1.user.oc1..xxxx"
oci_fingerprint       = "aa:bb:..."
oci_private_key_path  = "~/.oci/oci_api_key.pem"
oci_region            = "ap-mumbai-1"
oci_compartment_ocid  = "ocid1.tenancy.oc1..xxxx"
ssh_public_key        = "ssh-ed25519 AAAA..."
cloudflare_api_token  = "..."
cloudflare_account_id = "..."
platform_domain       = "autodeploy.eu.org"

# Who may SSH to the VM through Cloudflare Access (access.tf)
access_owner_email = "you@example.com"
