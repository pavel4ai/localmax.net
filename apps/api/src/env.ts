export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  SESSIONS: KVNamespace;
  VALIDATION: Queue<ValidationMessage>;

  SUBMIT_LIMITER: RateLimiter;
  READ_LIMITER: RateLimiter;

  ENVIRONMENT: string;
  SITE_ORIGIN: string;
  API_ORIGIN: string;
  MAX_ARTIFACT_BYTES: string;
  MAX_SUBMISSION_BYTES: string;
  TURNSTILE_SITE_KEY: string;

  // Secrets
  TURNSTILE_SECRET_KEY?: string;
  IP_HASH_SALT?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
}

export interface ValidationMessage {
  run_id: string;
  attempt: number;
}

/** A single machine-readable finding produced by validation. */
export interface Finding {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  field?: string;
}
