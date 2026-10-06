# Always Free only: one Ampere A1 VM at the free ceiling (2 OCPU / 12 GB as of
# June 2026), 100 GB boot volume, a VCN with *no* ingress rules. The VM is
# reached exclusively through the outbound Cloudflare Tunnel.

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.oci_tenancy_ocid
}

data "oci_core_images" "ubuntu_arm" {
  compartment_id           = var.oci_compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_vcn" "main" {
  compartment_id = var.oci_compartment_ocid
  cidr_blocks    = ["10.42.0.0/16"]
  display_name   = "autodeploy"
  dns_label      = "autodeploy"
}

resource "oci_core_internet_gateway" "igw" {
  compartment_id = var.oci_compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "autodeploy-igw"
}

resource "oci_core_route_table" "public" {
  compartment_id = var.oci_compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.igw.id
  }
}

resource "oci_core_security_list" "egress_only" {
  compartment_id = var.oci_compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "egress-only"
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }
  # No ingress, except SSH from one address while bootstrapping the VM
  # (infra/deploy/ship.sh). Afterwards SSH goes through the Cloudflare Tunnel.
  dynamic "ingress_security_rules" {
    for_each = var.bootstrap_ssh_cidr == "" ? [] : [var.bootstrap_ssh_cidr]
    content {
      source   = ingress_security_rules.value
      protocol = "6" # TCP
      tcp_options {
        min = 22
        max = 22
      }
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id    = var.oci_compartment_ocid
  vcn_id            = oci_core_vcn.main.id
  cidr_block        = "10.42.1.0/24"
  route_table_id    = oci_core_route_table.public.id
  security_list_ids = [oci_core_security_list.egress_only.id]
  dns_label         = "public"
}

resource "oci_core_instance" "vm" {
  compartment_id      = var.oci_compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = "autodeploy"
  shape               = "VM.Standard.A1.Flex"
  shape_config {
    ocpus         = var.vm_ocpus
    memory_in_gbs = var.vm_memory_gb
  }
  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu_arm.images[0].id
    boot_volume_size_in_gbs = 100
  }
  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true # needed for outbound internet; no inbound rules exist
  }
  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(file("${path.module}/../deploy/setup-vm.sh"))
  }
  # A newer Ubuntu image or an edited setup script must never replace a VM
  # that free-tier capacity made hard to get.
  lifecycle {
    ignore_changes = [metadata, source_details]
  }
}

output "vm_public_ip" { value = oci_core_instance.vm.public_ip }
output "vm_id" { value = oci_core_instance.vm.id }
