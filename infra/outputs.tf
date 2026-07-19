output "api_url" {
  description = "Public Function URL of the WCP API Lambda."
  value       = aws_lambda_function_url.api.function_url
}
