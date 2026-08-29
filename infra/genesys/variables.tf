variable "genesys_org_id" {
  description = "Genesys Cloud org id. Only used to compose the predicted partner event source name for the AWS stack."
  type        = string
}

variable "integration_name" {
  description = "Display name of the Genesys Cloud integration instance."
  type        = string
  default     = "DO - EventBridge AVA Monitoring"
}

variable "aws_account_id" {
  description = "12-digit AWS account that will receive the partner event source."
  type        = string

  validation {
    # Mirrors the pattern the integration's own config schema enforces.
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be exactly 12 digits."
  }
}

variable "aws_region" {
  description = "AWS region in which Genesys Cloud creates the partner event source."
  type        = string
}

variable "event_source_suffix" {
  description = "Unique suffix appended to the partner event source name. Must be unique across the org's integrations."
  type        = string

  validation {
    condition     = can(regex("^[.\\-_a-zA-Z0-9]{1,64}$", var.event_source_suffix))
    error_message = "event_source_suffix may contain only letters, digits, period, dash and underscore, max 64 characters."
  }
}

variable "topic_filters" {
  description = <<-EOT
    Notification topics to deliver to EventBridge. An empty list means Genesys sends nothing.
    Topics are org-wide: the {id} placeholder is not substituted, so every matching event in
    the org is delivered and must be filtered on the AWS side.
  EOT
  type        = list(string)

  default = [
    # The only topic carrying executionHistoryUri. This is the whole point of the project.
    "v2.flows.instances.flow.{id}",

    # Reconciliation signal for Validation 12. Carries no executionHistoryUri, so it is an
    # audit feed only, used to detect executions that never produced an archived history.
    "v2.detail.events.conversation.{id}.flow.end",
  ]
}

variable "intended_state" {
  description = "ENABLED starts event delivery immediately. Start DISABLED to stage config before opening the firehose."
  type        = string
  default     = "DISABLED"

  validation {
    condition     = contains(["ENABLED", "DISABLED"], var.intended_state)
    error_message = "intended_state must be ENABLED or DISABLED."
  }
}
