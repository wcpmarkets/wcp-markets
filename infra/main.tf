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

  # Secrets (DATABASE_URL, SUPABASE_*, JWT secret) get wired via SSM in a later
  # step; health works without them, and /me + /auth degrade gracefully.

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
