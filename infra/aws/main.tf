terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "GC-AVA-Explainability"
      ManagedBy = "Terraform"
      Stack     = "infra/aws"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  partner_source_name = "aws.partner/genesys.com/cloud/${var.genesys_org_id}/${var.event_source_suffix}"
  bucket_name         = "${var.name_prefix}-bronze-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
}

# Fails until Genesys has actually created the partner event source, which happens a few
# minutes after the integration is activated. scripts\wait-for-partner-source.ps1 polls for it.
data "aws_cloudwatch_event_source" "genesys" {
  name_prefix = local.partner_source_name
}

# ---------------------------------------------------------------- event bus

# The bus must carry the same name as the partner source it is associated with.
resource "aws_cloudwatch_event_bus" "genesys" {
  name              = data.aws_cloudwatch_event_source.genesys.name
  event_source_name = data.aws_cloudwatch_event_source.genesys.name
}

# ---------------------------------------------------------------- bronze storage

resource "aws_s3_bucket" "bronze" {
  bucket = local.bucket_name
}

# Raw evidence must survive a bad parser or an overwritten key.
resource "aws_s3_bucket_versioning" "bronze" {
  bucket = aws_s3_bucket.bronze.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "bronze" {
  bucket                  = aws_s3_bucket.bronze.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "bronze" {
  bucket = aws_s3_bucket.bronze.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "bronze" {
  bucket = aws_s3_bucket.bronze.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Phase 0 is an evidence exercise in a shared org, not a data lake. A hard expiry keeps
  # EU conversation content from accumulating indefinitely while validations run.
  rule {
    id     = "phase0-retention"
    status = var.bronze_expiration_days > 0 ? "Enabled" : "Disabled"
    filter {
      prefix = "bronze/"
    }
    expiration {
      days = var.bronze_expiration_days > 0 ? var.bronze_expiration_days : 365
    }
  }
}

# ---------------------------------------------------------------- manifest

resource "aws_dynamodb_table" "manifest" {
  name         = "${var.name_prefix}-manifest"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "eventReceivedAt"
    type = "S"
  }

  # Lets reconciliation ask "what is stuck in DOWNLOAD_PENDING or RECOVERY_REQUIRED"
  # without scanning the table.
  global_secondary_index {
    name            = "status-index"
    hash_key        = "status"
    range_key       = "eventReceivedAt"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = var.enable_pitr
  }
}

# ---------------------------------------------------------------- queues

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name_prefix}-collector-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
}

resource "aws_sqs_queue" "collector" {
  name = "${var.name_prefix}-collector"

  # The signed URI has a TTL, so a message sitting in the queue is a message at risk.
  # Short visibility timeout, aggressive redrive.
  visibility_timeout_seconds = var.lambda_timeout_seconds * 6
  message_retention_seconds  = 86400
  receive_wait_time_seconds  = 5

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

data "aws_iam_policy_document" "collector_queue" {
  statement {
    sid    = "AllowEventBridgeToSend"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.collector.arn]
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.execution_history.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "collector" {
  queue_url = aws_sqs_queue.collector.id
  policy    = data.aws_iam_policy_document.collector_queue.json
}

# ---------------------------------------------------------------- rules

# Genesys may deliver detail-type as the literal topic template or with {id} substituted,
# so this matches on prefix rather than assuming which.
#
# The optional flowId filter is the payoff from validation 9: the flow object publishes
# agenticVirtualAgentEnabled, so the set of flows that can contain an AVA is knowable up front
# (scripts\gc-build-ava-registry.ps1 writes it). In the target org that is 59 of 294 bot-like
# flows, so filtering here avoids downloading roughly 80% of bot-flow execution histories.
# Empty list means take every flow-instance event, which is the right default until the
# registry has been reviewed.
resource "aws_cloudwatch_event_rule" "execution_history" {
  name           = "${var.name_prefix}-execution-history"
  event_bus_name = aws_cloudwatch_event_bus.genesys.name
  description    = "Flow instance execution history notifications carrying executionHistoryUri"

  event_pattern = jsonencode(merge(
    { "detail-type" = [{ prefix = "v2.flows.instances.flow" }] },
    length(var.ava_flow_ids) > 0 ? { detail = { flowId = var.ava_flow_ids } } : {}
  ))
}

resource "aws_cloudwatch_event_target" "execution_history_to_sqs" {
  rule           = aws_cloudwatch_event_rule.execution_history.name
  event_bus_name = aws_cloudwatch_event_bus.genesys.name
  target_id      = "collector-queue"
  arn            = aws_sqs_queue.collector.arn
}

# Discovery net. Phase 0 does not yet know the exact detail-type shape Genesys emits, and a
# missed event is unrecoverable after the retention window, so everything on the bus is
# logged verbatim at short retention. This is what proves the prefix pattern above is right.
resource "aws_cloudwatch_event_rule" "all_events" {
  count          = var.enable_discovery_logging ? 1 : 0
  name           = "${var.name_prefix}-all-events"
  event_bus_name = aws_cloudwatch_event_bus.genesys.name
  description    = "Catch-all: logs every event on the Genesys partner bus for schema discovery"

  event_pattern = jsonencode({
    version = ["0"]
  })
}

resource "aws_cloudwatch_log_group" "raw_events" {
  count             = var.enable_discovery_logging ? 1 : 0
  name              = "/aws/events/${var.name_prefix}/raw"
  retention_in_days = var.raw_log_retention_days
}

resource "aws_cloudwatch_event_target" "all_events_to_logs" {
  count          = var.enable_discovery_logging ? 1 : 0
  rule           = aws_cloudwatch_event_rule.all_events[0].name
  event_bus_name = aws_cloudwatch_event_bus.genesys.name
  target_id      = "raw-log"
  arn            = aws_cloudwatch_log_group.raw_events[0].arn
}

data "aws_iam_policy_document" "raw_events_log" {
  count = var.enable_discovery_logging ? 1 : 0

  statement {
    sid    = "AllowEventBridgeToLog"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com", "delivery.logs.amazonaws.com"]
    }
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.raw_events[0].arn}:*"]
  }
}

resource "aws_cloudwatch_log_resource_policy" "raw_events" {
  count           = var.enable_discovery_logging ? 1 : 0
  policy_name     = "${var.name_prefix}-eventbridge-to-logs"
  policy_document = data.aws_iam_policy_document.raw_events_log[0].json
}

# ---------------------------------------------------------------- collector lambda

data "archive_file" "collector" {
  type        = "zip"
  source_dir  = "${path.module}/../../collector"
  excludes    = ["__pycache__", "**/__pycache__/**", "tests/**"]
  output_path = "${path.module}/build/collector.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "collector" {
  name               = "${var.name_prefix}-collector"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "collector" {
  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"]
  }

  statement {
    sid       = "ConsumeQueue"
    effect    = "Allow"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.collector.arn]
  }

  statement {
    sid       = "WriteBronze"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.bronze.arn}/*"]
  }

  statement {
    sid       = "Manifest"
    effect    = "Allow"
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"]
    resources = [aws_dynamodb_table.manifest.arn]
  }

  # The notification never carries content - executionHistoryUri was populated 0 of 30 times - so
  # the collector must call the Jobs API itself, which means it needs Genesys credentials. Scoped
  # to the one secret; the collector has no business reading any other.
  statement {
    sid       = "ReadGenesysCredentials"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.genesys_credentials_secret_arn]
  }
}

resource "aws_iam_role_policy" "collector" {
  name   = "collector"
  role   = aws_iam_role.collector.id
  policy = data.aws_iam_policy_document.collector.json
}

resource "aws_cloudwatch_log_group" "collector" {
  name              = "/aws/lambda/${var.name_prefix}-collector"
  retention_in_days = var.raw_log_retention_days
}

resource "aws_lambda_function" "collector" {
  function_name = "${var.name_prefix}-collector"
  role          = aws_iam_role.collector.arn
  handler       = "handler.handler"
  runtime       = "python3.12"
  timeout       = var.lambda_timeout_seconds
  memory_size   = var.lambda_memory_mb

  filename         = data.archive_file.collector.output_path
  source_code_hash = data.archive_file.collector.output_base64sha256

  environment {
    variables = {
      BRONZE_BUCKET            = aws_s3_bucket.bronze.id
      MANIFEST_TABLE           = aws_dynamodb_table.manifest.name
      COLLECTOR_VERSION        = var.collector_version
      DOWNLOAD_TIMEOUT_SECONDS = tostring(var.lambda_timeout_seconds - 5)
      LOG_LEVEL                = "INFO"

      # Kept in step with the queue's redrive threshold so the collector can recognise its
      # final attempt and mark the execution for Jobs recovery before the record hits the DLQ.
      MAX_RECEIVE_COUNT = tostring(var.max_receive_count)

      # Jobs API retrieval. The id ceiling is measured, not guessed: 10 ids are accepted and 11
      # are rejected with a bare 422, so this must not drift above 10.
      GENESYS_API_HOST              = var.genesys_api_host
      GENESYS_LOGIN_HOST            = var.genesys_login_host
      GENESYS_CREDENTIALS_SECRET_ID = var.genesys_credentials_secret_arn
      JOBS_MAX_IDS                  = tostring(var.jobs_max_ids)
      JOBS_TIMEOUT_SECONDS          = tostring(var.lambda_timeout_seconds - 10)
    }
  }

  depends_on = [aws_cloudwatch_log_group.collector]
}

resource "aws_lambda_event_source_mapping" "collector" {
  event_source_arn = aws_sqs_queue.collector.arn
  function_name    = aws_lambda_function.collector.arn

  batch_size                         = var.batch_size
  maximum_batching_window_in_seconds = 0

  # Without this, one retryable record forces the whole batch to be redelivered and the
  # already-archived records get reprocessed.
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.max_download_concurrency
  }
}

# ---------------------------------------------------------------- alarms

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.name_prefix}-dlq-not-empty"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  period              = 300
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  treat_missing_data  = "notBreaching"
  alarm_description   = "Executions failed permanently. Each one is a potential silent gap in the archive."

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }
}

# Queue age matters more than queue depth here: the signed URI expires, so a backlog is a
# data-loss risk rather than just a latency problem.
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${var.name_prefix}-queue-age"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.queue_age_alarm_seconds
  evaluation_periods  = 1
  period              = 60
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  treat_missing_data  = "notBreaching"
  alarm_description   = "Oldest queued notification is approaching executionHistoryUri expiry."

  dimensions = {
    QueueName = aws_sqs_queue.collector.name
  }
}

# ---------------------------------------------------------------- cost guardrails

# These are deliberately part of the stack rather than a manual console step. The dominant
# risk here is not a mispriced resource, it is an org-wide firehose whose volume nobody has
# measured yet: every flow execution in a 631-flow shared org arrives whether we store it or
# not, and CloudWatch Logs ingestion bills per GB.
#
# Budgets and Cost Explorer are global services billed in us-east-1, so they need their own
# provider alias regardless of where the workload runs.
provider "aws" {
  alias  = "billing"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "GC-AVA-Explainability"
      ManagedBy = "Terraform"
      Stack     = "infra/aws"
    }
  }
}

resource "aws_budgets_budget" "stack" {
  count = var.monthly_budget_usd > 0 ? 1 : 0

  provider     = aws.billing
  name         = "${var.name_prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$GC-AVA-Explainability"]
  }

  # Actual thresholds catch what has already happened; the forecast threshold is the one that
  # gives useful warning while a firehose is ramping.
  dynamic "notification" {
    for_each = length(var.budget_alert_emails) > 0 ? [50, 80, 100] : []
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = var.budget_alert_emails
    }
  }

  dynamic "notification" {
    for_each = length(var.budget_alert_emails) > 0 ? [100] : []
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "FORECASTED"
      subscriber_email_addresses = var.budget_alert_emails
    }
  }
}

resource "aws_ce_anomaly_monitor" "stack" {
  count = var.enable_anomaly_detection ? 1 : 0

  provider          = aws.billing
  name              = "${var.name_prefix}-anomalies"
  monitor_type      = "CUSTOM"
  monitor_dimension = null

  # Written in the exact shape Cost Explorer returns - the "user:" tag prefix and the explicit
  # nulls - because any difference forces a replacement of the monitor on every plan.
  monitor_specification = jsonencode({
    And            = null
    CostCategories = null
    Dimensions     = null
    Not            = null
    Or             = null
    Tags = {
      Key          = "user:Project"
      Values       = ["GC-AVA-Explainability"]
      MatchOptions = ["EQUALS"]
    }
  })
}

# Anomaly detection only reports if something is subscribed to it, so without an address the
# monitor is created but silent. That is still useful in the console, hence no hard failure.
resource "aws_ce_anomaly_subscription" "stack" {
  count = var.enable_anomaly_detection && length(var.budget_alert_emails) > 0 ? 1 : 0

  provider  = aws.billing
  name      = "${var.name_prefix}-anomaly-alerts"
  frequency = "DAILY"

  monitor_arn_list = [aws_ce_anomaly_monitor.stack[0].arn]

  subscriber {
    type    = "EMAIL"
    address = var.budget_alert_emails[0]
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = ["5"]
    }
  }
}
