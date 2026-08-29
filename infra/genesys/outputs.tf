output "integration_id" {
  description = "Genesys Cloud integration instance id."
  value       = genesyscloud_integration.ava_explainability.id
}

output "partner_event_source_name" {
  description = "Name of the partner event source Genesys creates in AWS. The AWS event bus must carry this exact name."
  value       = "aws.partner/genesys.com/cloud/${var.genesys_org_id}/${var.event_source_suffix}"
}

output "topic_filters" {
  description = "Topics this integration delivers."
  value       = var.topic_filters
}
