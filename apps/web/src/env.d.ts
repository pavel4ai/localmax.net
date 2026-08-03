/// <reference types="astro/client" />

interface WorkerEnv {
  API?: { fetch: typeof fetch };
  ASSETS?: { fetch: typeof fetch };
  ENVIRONMENT?: string;
  API_ORIGIN?: string;
}

declare namespace App {
  interface Locals {
    runtime: {
      env: WorkerEnv;
      cf?: unknown;
      ctx: { waitUntil(promise: Promise<unknown>): void };
    };
  }
}
