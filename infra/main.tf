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
