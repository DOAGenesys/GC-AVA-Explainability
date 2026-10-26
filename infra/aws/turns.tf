# ---------------------------------------------------------------- reporting turns sweep
#
# The partner-bus collector only hears about executions that reach their flow's exit. An AVA
# session that ends any other way - the customer closes the chat, the conversation is
# transferred, the bot is disconnected - writes no execution history and emits no event, so it
# never reaches the bus. Bot Flow Reporting Turns does record those sessions, and since the
# September and October 2026 releases it carries each AVA turn's tool calls and the AVA's name
# and version. This schedule pulls it into durable storage before the ~10 day retention drops it.

resource "aws_dynamodb_table" "turns" {
  name         = "${var.name_prefix}-turns"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "day"
    type = "S"
  }

  attribute {
    name = "firstTurnAt"
    type = "S"
  }

  attribute {
    name = "conversationId"
    type = "S"
  }

  # Sessions by the UTC day of their first turn, newest first. Sweep watermarks share the index
  # under day = "SWEEP" so the status of every flow is one query. DynamoDB allows 20 projected
  # attributes per index; anything else is read from the item itself.
  global_secondary_index {
    name            = "day-index"
    hash_key        = "day"
    range_key       = "firstTurnAt"
    projection_type = "INCLUDE"
    non_key_attributes = [
      "sessionId", "conversationId", "flowId", "flowName", "lastTurnAt", "turnCount", "toolCallCount",
      "toolFailureCount", "guardrailCount", "agentName", "agentVersion", "endType", "lastResult", "watermark",
      "lastRunAt", "lastRunComplete", "lastRunPages", "lastRunTurns", "lastRunSessions", "lastError",
    ]
  }

  # Lets the web app attach turn evidence to a session it already knows by conversation.
  global_secondary_index {
    name               = "conversation-index"
    hash_key           = "conversationId"
    projection_type    = "INCLUDE"
    non_key_attributes = ["sessionId", "firstTurnAt"]
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.enable_pitr
  }
}

resource "aws_iam_role" "turns_sweep" {
  name               = "${var.name_prefix}-turns-sweep"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "turns_sweep" {
  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.turns_sweep.arn}:*"]
  }

  statement {
    sid       = "WriteRawTurnPages"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.bronze.arn}/bronze/turns/*"]
  }

  statement {
    sid       = "Sessions"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.turns.arn, "${aws_dynamodb_table.turns.arn}/index/day-index"]
  }

  statement {
    sid       = "ReadGenesysCredentials"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.genesys_credentials_secret_arn]
  }
}

resource "aws_iam_role_policy" "turns_sweep" {
  name   = "turns-sweep"
  role   = aws_iam_role.turns_sweep.id
  policy = data.aws_iam_policy_document.turns_sweep.json
}

resource "aws_cloudwatch_log_group" "turns_sweep" {
  name              = "/aws/lambda/${var.name_prefix}-turns-sweep"
  retention_in_days = var.raw_log_retention_days
}

resource "aws_lambda_function" "turns_sweep" {
  function_name = "${var.name_prefix}-turns-sweep"
  role          = aws_iam_role.turns_sweep.arn
  handler       = "turns_sweep.handler"
  runtime       = "python3.12"
  timeout       = var.turns_sweep_timeout_seconds
  memory_size   = 512

  # No reserved concurrency: this account's limit leaves none to reserve. The timeout is far below
  # the schedule interval, and overlapping runs would only re-merge the same turns anyway.

  filename         = data.archive_file.collector.output_path
  source_code_hash = data.archive_file.collector.output_base64sha256

  environment {
    variables = {
      BRONZE_BUCKET                 = aws_s3_bucket.bronze.id
      TURNS_TABLE                   = aws_dynamodb_table.turns.name
      GENESYS_ORG_ID                = var.genesys_org_id
      GENESYS_API_HOST              = var.genesys_api_host
      GENESYS_LOGIN_HOST            = var.genesys_login_host
      GENESYS_CREDENTIALS_SECRET_ID = var.genesys_credentials_secret_arn
      TURNS_EXTRA_FLOW_IDS          = join(",", var.turns_extra_flow_ids)
      LOG_LEVEL                     = "INFO"
    }
  }

  depends_on = [aws_cloudwatch_log_group.turns_sweep]
}

resource "aws_cloudwatch_event_rule" "turns_sweep" {
  name                = "${var.name_prefix}-turns-sweep"
  description         = "Pulls Bot Flow Reporting Turns for every AVA flow into durable storage"
  schedule_expression = var.turns_sweep_schedule
  state               = var.enable_turns_sweep ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "turns_sweep" {
  rule      = aws_cloudwatch_event_rule.turns_sweep.name
  target_id = "turns-sweep"
  arn       = aws_lambda_function.turns_sweep.arn
}

resource "aws_lambda_permission" "turns_sweep_schedule" {
  statement_id  = "AllowSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.turns_sweep.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.turns_sweep.arn
}

# A failed run is recovered by the next one, but a sweep that keeps failing lets sessions age
# out of the platform's retention unseen.
resource "aws_cloudwatch_metric_alarm" "turns_sweep_errors" {
  alarm_name          = "${var.name_prefix}-turns-sweep-errors"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  period              = 3600
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_description   = "The Reporting Turns sweep has failed three hours running."

  dimensions = {
    FunctionName = aws_lambda_function.turns_sweep.function_name
  }
}

# ---------------------------------------------------------------- web app read access
#
# The web app on Vercel reads the sweep's sessions with short-lived credentials from Vercel's
# OIDC federation, so no AWS key exists anywhere to leak. The role can only Query and GetItem
# the turns table.

resource "aws_iam_openid_connect_provider" "vercel" {
  count = var.vercel_team_slug != "" ? 1 : 0

  url            = "https://oidc.vercel.com/${var.vercel_team_slug}"
  client_id_list = ["https://vercel.com/${var.vercel_team_slug}"]
}

data "aws_iam_policy_document" "web_reader_assume" {
  count = var.vercel_team_slug != "" ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.vercel[0].arn]
    }
    condition {
      test     = "StringEquals"
      variable = "oidc.vercel.com/${var.vercel_team_slug}:aud"
      values   = ["https://vercel.com/${var.vercel_team_slug}"]
    }
    condition {
      test     = "StringEquals"
      variable = "oidc.vercel.com/${var.vercel_team_slug}:sub"
      values = [
        for environment in var.vercel_environments :
        "owner:${var.vercel_team_slug}:project:${var.vercel_project_name}:environment:${environment}"
      ]
    }
  }
}

resource "aws_iam_role" "web_reader" {
  count = var.vercel_team_slug != "" ? 1 : 0

  name                 = "${var.name_prefix}-web-reader"
  assume_role_policy   = data.aws_iam_policy_document.web_reader_assume[0].json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "web_reader" {
  statement {
    sid     = "ReadTurnSessions"
    effect  = "Allow"
    actions = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [
      aws_dynamodb_table.turns.arn,
      "${aws_dynamodb_table.turns.arn}/index/day-index",
      "${aws_dynamodb_table.turns.arn}/index/conversation-index",
    ]
  }
}

resource "aws_iam_role_policy" "web_reader" {
  count = var.vercel_team_slug != "" ? 1 : 0

  name   = "read-turn-sessions"
  role   = aws_iam_role.web_reader[0].id
  policy = data.aws_iam_policy_document.web_reader.json
}
