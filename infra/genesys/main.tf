terraform {
  required_version = ">= 1.9.0"
  required_providers {
    genesyscloud = {
      source  = "mypurecloud/genesyscloud"
      version = "~> 1.85"
    }
  }
}

# Credentials come from GENESYSCLOUD_OAUTHCLIENT_ID / _SECRET / GENESYSCLOUD_REGION,
# exported by scripts\load-genesys-env.ps1 from the MCP config. Nothing is stored here.
provider "genesyscloud" {}

# Creating this integration causes Genesys Cloud to create a partner event source in the
# target AWS account roughly five minutes after it becomes ENABLED. The AWS stack cannot
# be applied until that source exists, which is why this is a separate root module.
resource "genesyscloud_integration" "ava_explainability" {
  integration_type = "amazon-eventbridge-source"
  intended_state   = var.intended_state

  config {
    name = var.integration_name

    properties = jsonencode({
      awsAccountId      = var.aws_account_id
      awsAccountRegion  = var.aws_region
      eventSourceSuffix = var.event_source_suffix
      eventFilter       = var.topic_filters
    })

    advanced = jsonencode({})

    notes = join(" | ", [
      "AVA explainability at scale - execution history collection",
      "AWS ${var.aws_account_id} / ${var.aws_region}",
      "Managed by Terraform: infra/genesys",
    ])
  }
}
