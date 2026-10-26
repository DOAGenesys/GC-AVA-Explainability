variable "aws_region" {
  description = "Region the partner event source was created in. Must match the Genesys integration's awsAccountRegion."
  type        = string
}

variable "genesys_org_id" {
  description = "Genesys Cloud org id, used to compose the partner event source name."
  type        = string
}

variable "event_source_suffix" {
  description = "Suffix configured on the Genesys integration."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for all resource names."
  type        = string
  default     = "ava-explain"
}

variable "ava_flow_ids" {
  description = <<-EOT
    Flow ids whose execution histories are worth downloading, normally the
    agenticVirtualAgentEnabled set produced by scripts\gc-build-ava-registry.ps1.

    Empty means accept every flow-instance event, which is the correct default until the
    registry has been reviewed: an over-narrow filter silently discards events that cannot be
    recovered once the signed URI expires.
  EOT
  type        = list(string)
  default     = []
}

variable "collector_version" {
  description = "Recorded on every Bronze object so artifacts can be attributed to collector behaviour."
  type        = string
  default     = "0.1.0"
}

variable "lambda_timeout_seconds" {
  description = "Collector timeout. Must comfortably exceed the slowest expected execution-history download."
  type        = number
  default     = 60
}

variable "lambda_memory_mb" {
  description = "Collector memory. Raises network throughput as a side effect."
  type        = number
  default     = 512
}

variable "batch_size" {
  description = <<-EOT
    SQS records per invocation, deliberately equal to the Jobs API's measured id ceiling.

    Retrieval goes through the Jobs API because the notification never carries content, and a job
    costs the same 2 API calls whether it carries 1 id or 10. So the SQS batch size IS the API
    efficiency: at 10 the collector spends 0.2 API calls per execution, at 1 it spends 2. Raising
    this above 10 does not help - the collector will still split at 10 - and lowering it multiplies
    API load proportionally.
  EOT
  type        = number
  default     = 10
}

variable "jobs_max_ids" {
  description = <<-EOT
    Execution ids per Jobs API request. Measured ceiling, not a guess: 10 is accepted and 11 is
    rejected with a bare 422 naming no id. Do not raise this - an over-large batch is rejected
    wholesale and degrades into bisection, which costs more calls than batching saves.
  EOT
  type        = number
  default     = 10

  validation {
    condition     = var.jobs_max_ids >= 1 && var.jobs_max_ids <= 10
    error_message = "The Jobs API rejects batches larger than 10 ids."
  }
}

variable "genesys_api_host" {
  description = "Platform API host for the org's region, e.g. api.mypurecloud.de."
  type        = string
  default     = "api.mypurecloud.de"
}

variable "genesys_login_host" {
  description = "Login host used for the client-credentials grant, e.g. login.mypurecloud.de."
  type        = string
  default     = "login.mypurecloud.de"
}

variable "genesys_credentials_secret_arn" {
  description = <<-EOT
    ARN of a Secrets Manager secret holding {"clientId": "...", "clientSecret": "..."} for a
    Genesys OAuth client-credentials grant with permission to read flow execution history.

    The collector needs this because retrieval is Jobs-based: the notification names an execution
    but never carries its content, so archiving requires an authenticated API call back to
    Genesys. The secret is created outside this stack so the credential never passes through
    Terraform state.
  EOT
  type        = string
}

variable "max_download_concurrency" {
  description = <<-EOT
    Ceiling on concurrent collector invocations, and therefore on concurrent Jobs API callers.

    Still deliberately low. The content downloads themselves are served from a separate download
    host and so are outside the Platform API budget, but the job submissions and polls are not,
    and no inin-ratelimit-* headers were returned on those endpoints, so the sustainable rate is
    un-measured. Discovering it by triggering throttling in a shared production org would be the
    wrong way to find out.

    At this value the stack's steady-state cost is 5 x 2 API calls per 10 executions in flight.
  EOT
  type        = number
  default     = 5
}

variable "max_receive_count" {
  description = "Redrive threshold before a notification goes to the DLQ."
  type        = number
  default     = 5
}

variable "raw_log_retention_days" {
  description = "Retention for the discovery log group and Lambda logs."
  type        = number
  default     = 7
}

variable "bronze_expiration_days" {
  description = "Hard expiry on Bronze objects. Set to 0 to keep indefinitely."
  type        = number
  default     = 30
}

variable "queue_age_alarm_seconds" {
  description = "Alarm when the oldest queued notification exceeds this age, as a proxy for approaching URI expiry."
  type        = number
  default     = 300
}

# ------------------------------------------------------------------ cost controls

variable "enable_discovery_logging" {
  description = <<-EOT
    Logs every event on the partner bus verbatim, to establish the real detail-type shape
    and prove the execution-history rule's prefix pattern is correct.

    This is the single largest cost line in the stack, because CloudWatch Logs bills
    $0.50/GB ingested and this rule ingests 100% of an org-wide firehose. Turn it off once
    the event shape is confirmed - the execution-history rule and the Bronze bucket already
    retain everything we actually need.
  EOT
  type        = bool
  default     = true
}

variable "enable_pitr" {
  description = <<-EOT
    Point-in-time recovery on the manifest table. Off by default: the manifest is derivable
    by replaying the Bronze envelopes, so paying for continuous backups of reconstructible
    state is not worth it in an R&D account.
  EOT
  type        = bool
  default     = false
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget for this stack. Set to 0 to skip creating a budget."
  type        = number
  default     = 10
}

variable "budget_alert_emails" {
  description = "Addresses notified at 50%, 80% and 100% of budget, plus on forecast overrun. Empty list skips notifications."
  type        = list(string)
  default     = []
}

# ------------------------------------------------------------------ reporting turns sweep

variable "enable_turns_sweep" {
  description = "Run the scheduled Reporting Turns sweep. The Lambda and table exist either way."
  type        = bool
  default     = true
}

variable "turns_sweep_schedule" {
  description = <<-EOT
    How often the sweep runs. Hourly keeps the window small and leaves days of slack before the
    platform's ~10 day Reporting Turns retention. Each run costs roughly one API call per AVA flow
    plus one per 250 turns.
  EOT
  type        = string
  default     = "rate(1 hour)"
}

variable "turns_sweep_timeout_seconds" {
  description = "Sweep timeout. Flows not reached in time keep their watermark and are picked up next run."
  type        = number
  default     = 300
}

variable "turns_extra_flow_ids" {
  description = "Flow ids to sweep in addition to every flow whose agenticVirtualAgentEnabled flag is set."
  type        = list(string)
  default     = []
}

# ------------------------------------------------------------------ web app read access

variable "vercel_team_slug" {
  description = "Vercel team slug that issues the web app's OIDC tokens. Empty skips the OIDC provider and reader role."
  type        = string
  default     = ""
}

variable "vercel_project_name" {
  description = "Vercel project allowed to assume the reader role."
  type        = string
  default     = "gc-ava-explainability"
}

variable "vercel_environments" {
  description = "Vercel environments allowed to assume the reader role."
  type        = list(string)
  default     = ["production"]
}

variable "enable_anomaly_detection" {
  description = "AWS Cost Anomaly Detection on this stack's tagged spend. Free, and catches a runaway firehose faster than a monthly budget can."
  type        = bool
  default     = true
}
