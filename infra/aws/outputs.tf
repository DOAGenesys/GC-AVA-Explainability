output "partner_event_source_name" {
  description = "Partner event source discovered in AWS."
  value       = data.aws_cloudwatch_event_source.genesys.name
}

output "event_bus_name" {
  description = "Event bus associated with the Genesys partner source."
  value       = aws_cloudwatch_event_bus.genesys.name
}

output "bronze_bucket" {
  description = "Immutable raw execution-history storage."
  value       = aws_s3_bucket.bronze.id
}

output "manifest_table" {
  description = "Ingestion manifest and idempotency store."
  value       = aws_dynamodb_table.manifest.name
}

output "collector_queue_url" {
  description = "Durable queue feeding the collector."
  value       = aws_sqs_queue.collector.id
}

output "dlq_url" {
  description = "Dead letter queue. Anything here is a candidate archive gap."
  value       = aws_sqs_queue.dlq.id
}

output "raw_event_log_group" {
  description = "Catch-all log group. Tail this to watch events arrive as you run Genesys tests. Null when discovery logging is off."
  value       = var.enable_discovery_logging ? aws_cloudwatch_log_group.raw_events[0].name : null
}

output "watch_command" {
  description = "Ready-to-run command to watch events land in real time."
  value = (var.enable_discovery_logging
    ? "aws logs tail ${aws_cloudwatch_log_group.raw_events[0].name} --follow --region ${var.aws_region}"
  : "discovery logging is disabled; set enable_discovery_logging = true to watch raw events")
}

output "execution_history_rule_pattern" {
  description = "The live event pattern, so the effective flow filter is visible without opening the console."
  value       = aws_cloudwatch_event_rule.execution_history.event_pattern
}

output "turns_table" {
  description = "Reporting Turns sessions and per-flow sweep watermarks."
  value       = aws_dynamodb_table.turns.name
}

output "turns_sweep_function" {
  description = "Scheduled Reporting Turns sweep. Invoke it by hand to backfill immediately."
  value       = aws_lambda_function.turns_sweep.function_name
}

output "web_reader_role_arn" {
  description = "Role the Vercel web app assumes through OIDC. Set it as AVA_TURNS_ROLE_ARN. Null when vercel_team_slug is empty."
  value       = var.vercel_team_slug != "" ? aws_iam_role.web_reader[0].arn : null
}

output "ava_flow_filter_count" {
  description = "Number of flow ids in the rule filter. 0 means every flow-instance event is accepted."
  value       = length(var.ava_flow_ids)
}
