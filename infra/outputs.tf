output "api_url" {
  description = "Public Function URL of the WCP API Lambda (may be blocked on Free plan)."
  value       = aws_lambda_function_url.api.function_url
}

output "api_gateway_url" {
  description = "Public API Gateway HTTP API URL — the primary public entry."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "deal_events_queue_url" {
  value       = aws_sqs_queue.deal_events.url
  description = "SQS queue the sweeper relays the outbox to (M4 consumer reads it)."
}
