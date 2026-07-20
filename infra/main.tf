locals {
  name = "wcp-api"
}

# Package the pre-built esbuild bundle (services/api → dist/lambda.mjs).
data "archive_file" "api" {
  type        = "zip"
  source_file = "${path.module}/../services/api/dist/lambda.mjs"
  output_path = "${path.module}/build/api.zip"
}

# ── IAM execution role ──────────────────────────────────────────────────────
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.name}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_caller_identity" "current" {}

# Let the Lambda read + decrypt its secrets from SSM (/wcp/api/*).
resource "aws_iam_role_policy" "api_ssm" {
  name = "${local.name}-ssm-read"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:eu-west-1:${data.aws_caller_identity.current.account_id}:parameter/wcp/api/*"
      },
      {
        # Decrypt SecureString params (AWS-managed aws/ssm key). Tighten to the
        # specific key ARN later.
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
      }
    ]
  })
}

# ── Log group (explicit, so we control retention from day one) ──────────────
resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 14
}

# ── The API Lambda (ARM64 / Graviton, cheaper + faster cold starts) ─────────
resource "aws_lambda_function" "api" {
  function_name    = local.name
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "lambda.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  memory_size      = 256
  timeout          = 15

  environment {
    variables = {
      # Public value → enables cloud ES256/JWKS token verification on /me.
      SUPABASE_URL = var.supabase_url
      # Name (not value) of the SSM SecureString holding the Supavisor pooler
      # connection string. The Lambda fetches + decrypts it at runtime — the
      # secret is never in this env config, TF state, or git.
      DATABASE_URL_SSM = "/wcp/api/database-url"
      # Same pattern for the Supabase service key (used to mint signed Storage
      # URLs for the private listing-images bucket).
      SUPABASE_SECRET_KEY_SSM = "/wcp/api/supabase-secret-key"
      # HMAC secret for verifying escrow-partner (Mock) webhook signatures.
      ESCROW_WEBHOOK_SECRET_SSM = "/wcp/api/escrow-webhook-secret"
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

# ── Public Function URL (auth + rate-limiting are enforced in-app) ──────────
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = ["*"]
    allow_methods = ["*"]
    allow_headers = ["*"]
  }
}

# A public (AuthType NONE) Function URL still needs a resource-based policy that
# permits unauthenticated invoke — without this, callers get 403 Forbidden.
resource "aws_lambda_permission" "api_url_public" {
  statement_id           = "AllowPublicFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# ── API Gateway HTTP API (public-by-default; the primary public entry) ───────
# $default catch-all → Lambda proxy; Hono does the internal routing. Gives us a
# stable public URL, CORS, and built-in throttling (belt for the OTP path).
resource "aws_apigatewayv2_api" "http" {
  name          = "${local.name}-http"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["*"]
    allow_headers = ["*"]
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 20
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

# ─────────────────────────────────────────────────────────────────────────────
# The sweeper: a 60s EventBridge cron → Lambda that fires due deal deadlines
# (auto-expiry/release/refund) and relays the transactional outbox to SQS.
# ─────────────────────────────────────────────────────────────────────────────

# ── Outbox target: a standard queue + DLQ ────────────────────────────────────
resource "aws_sqs_queue" "deal_events_dlq" {
  name                      = "${local.name}-deal-events-dlq"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_sqs_queue" "deal_events" {
  name                       = "${local.name}-deal-events"
  visibility_timeout_seconds = 60
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.deal_events_dlq.arn
    maxReceiveCount     = 5
  })
}

# ── Sweeper IAM role (least-privilege: logs + SSM read + SQS send) ────────────
resource "aws_iam_role" "sweeper" {
  name               = "${local.name}-sweeper-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "sweeper_logs" {
  role       = aws_iam_role.sweeper.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "sweeper_perms" {
  name = "${local.name}-sweeper-perms"
  role = aws_iam_role.sweeper.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:eu-west-1:${data.aws_caller_identity.current.account_id}:parameter/wcp/api/*"
      },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = "*" },
      { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.deal_events.arn },
    ]
  })
}

# ── Sweeper Lambda ───────────────────────────────────────────────────────────
data "archive_file" "sweeper" {
  type        = "zip"
  source_file = "${path.module}/../services/api/dist/sweeper.mjs"
  output_path = "${path.module}/build/sweeper.zip"
}

resource "aws_cloudwatch_log_group" "sweeper" {
  name              = "/aws/lambda/${local.name}-sweeper"
  retention_in_days = 14
}

resource "aws_lambda_function" "sweeper" {
  function_name    = "${local.name}-sweeper"
  role             = aws_iam_role.sweeper.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "sweeper.handler"
  filename         = data.archive_file.sweeper.output_path
  source_code_hash = data.archive_file.sweeper.output_base64sha256
  memory_size      = 256
  timeout          = 50 # < the 60s cadence to keep a run short; overlap is still
  # possible (EventBridge→Lambda is async + at-least-once) but the sweeper's jobs are
  # safe under concurrent runs (FOR UPDATE + state_token fence; SKIP LOCKED relay).

  environment {
    variables = {
      DATABASE_URL_SSM = "/wcp/api/database-url"
      OUTBOX_QUEUE_URL = aws_sqs_queue.deal_events.url
    }
  }

  depends_on = [aws_cloudwatch_log_group.sweeper]
}

# Async invokes: don't let the Lambda service retry a throwing run — the next tick is
# 60s away and a retry only adds an overlapping run.
resource "aws_lambda_function_event_invoke_config" "sweeper" {
  function_name          = aws_lambda_function.sweeper.function_name
  maximum_retry_attempts = 0
}

# ── EventBridge: fire the sweeper every minute ───────────────────────────────
resource "aws_cloudwatch_event_rule" "sweeper_tick" {
  name                = "${local.name}-sweeper-tick"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "sweeper" {
  rule = aws_cloudwatch_event_rule.sweeper_tick.name
  arn  = aws_lambda_function.sweeper.arn
}

resource "aws_lambda_permission" "sweeper_events" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sweeper.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sweeper_tick.arn
}

# ── Alerting: the sweeper must never fail silently ───────────────────────────
# A silent/stopped sweeper freezes every escrow timer with a green dashboard — the
# single most dangerous failure mode. Two alarms cover it: it errored, and it stopped
# running at all. Both notify an email via SNS.
resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# (1) The sweeper threw at least once in the last minute.
resource "aws_cloudwatch_metric_alarm" "sweeper_errors" {
  alarm_name          = "${local.name}-sweeper-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.sweeper.function_name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_description    = "Sweeper Lambda threw — a timer/relay run failed."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# (2) The sweeper stopped running (disabled rule, bad deploy, IAM drift). No
# invocations produces NO datapoints, so treat_missing_data must be "breaching" or
# this never fires — the part everyone forgets.
resource "aws_cloudwatch_metric_alarm" "sweeper_not_running" {
  alarm_name          = "${local.name}-sweeper-not-running"
  namespace           = "AWS/Lambda"
  metric_name         = "Invocations"
  dimensions          = { FunctionName = aws_lambda_function.sweeper.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_description    = "Sweeper has not run in 5 minutes — escrow timers are frozen."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# ─────────────────────────────────────────────────────────────────────────────
# The escrow orchestrator (M4): an SQS consumer on the deal-events queue that turns
# escrow.* outbox commands into (mock) provider calls + signed webhooks back to the
# API. Non-escrow messages are acked untouched.
# ─────────────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "consumer" {
  name               = "${local.name}-consumer-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "consumer_logs" {
  role       = aws_iam_role.consumer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "consumer_perms" {
  name = "${local.name}-consumer-perms"
  role = aws_iam_role.consumer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:eu-west-1:${data.aws_caller_identity.current.account_id}:parameter/wcp/api/*"
      },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = "*" },
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.deal_events.arn
      },
    ]
  })
}

data "archive_file" "consumer" {
  type        = "zip"
  source_file = "${path.module}/../services/api/dist/consumer.mjs"
  output_path = "${path.module}/build/consumer.zip"
}

resource "aws_cloudwatch_log_group" "consumer" {
  name              = "/aws/lambda/${local.name}-consumer"
  retention_in_days = 14
}

resource "aws_lambda_function" "consumer" {
  function_name    = "${local.name}-consumer"
  role             = aws_iam_role.consumer.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "consumer.handler"
  filename         = data.archive_file.consumer.output_path
  source_code_hash = data.archive_file.consumer.output_base64sha256
  memory_size      = 256
  timeout          = 30

  environment {
    variables = {
      ESCROW_WEBHOOK_SECRET_SSM = "/wcp/api/escrow-webhook-secret"
      API_URL                   = aws_apigatewayv2_api.http.api_endpoint
    }
  }

  depends_on = [aws_cloudwatch_log_group.consumer]
}

# Poll the deal-events queue → invoke the consumer. ReportBatchItemFailures so only a
# failed record is retried, not the whole batch.
resource "aws_lambda_event_source_mapping" "consumer" {
  event_source_arn                   = aws_sqs_queue.deal_events.arn
  function_name                      = aws_lambda_function.consumer.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
  function_response_types            = ["ReportBatchItemFailures"]
}
