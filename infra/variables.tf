variable "supabase_url" {
  description = "Public Supabase project URL (used for JWKS token verification). Not a secret."
  type        = string
  default     = "https://akqxdlpkymfeihuwnmaf.supabase.co"
}

variable "alert_email" {
  description = "Email subscribed to the SNS alerts topic (sweeper errors / not-running)."
  type        = string
  default     = "wcpmarketsng@gmail.com"
}
