import { getAgentByName } from "agents";
import type { Env } from "./env";
import { verifyWebhookSignature } from "./crypto";
import { RepositoryStore } from "./store";
import { parseWebhook, shouldIgnoreEvent, threadName } from "./webhook";

export { RepositoryThreadAgent } from "./thread-agent";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", environment: env.APP_ENV });
    }
    if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
      return json({ error: "Not found" }, 404);
    }
    const deliveryId = request.headers.get("X-GitHub-Delivery");
    const eventName = request.headers.get("X-GitHub-Event");
    if (!deliveryId || !eventName) return json({ error: "Missing GitHub headers" }, 400);
    const body = await request.text();
    const valid = await verifyWebhookSignature(
      body,
      request.headers.get("X-Hub-Signature-256"),
      env.GITHUB_WEBHOOK_SECRET,
    );
    if (!valid) return json({ error: "Invalid signature" }, 401);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const event = parseWebhook(eventName, deliveryId, payload);
    if (!event || shouldIgnoreEvent(event)) return json({ ignored: true }, 202);
    const store = new RepositoryStore(env.DB);
    if (!(await store.claimDelivery(event))) return json({ duplicate: true }, 202);
    const agent = await getAgentByName(env.REPOSITORY_THREAD, threadName(event));
    await agent.receiveEvent(event);
    return json({ queued: true }, 202);
  },
} satisfies ExportedHandler<Env>;
