import type { RepositoryThreadAgent } from "./thread-agent";

export interface Env extends Cloudflare.Env {
  REPOSITORY_THREAD: DurableObjectNamespace<RepositoryThreadAgent>;
  DB: D1Database;
  APP_ENV: string;
  GITHUB_API_VERSION: string;
  MODEL_BASE_URL: string;
  MODEL_NAME: string;
  PROMPT_VERSION: string;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  MODEL_API_KEY: string;
  AI_GATEWAY_TOKEN?: string;
}
