import { createServer } from "node:http";
import { chmod, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const port = 3210;
const origin = `http://127.0.0.1:${port}`;
const state = randomBytes(24).toString("hex");
const outputPath = new URL("../.github-app-credentials.json", import.meta.url);
const manifest = {
  name: "Conflux Agent",
  url: "https://github.com/Conflux-Union/conflux-agent",
  description: "Stateful maintenance agent for issue and pull request triage.",
  hook_attributes: {
    url: "https://conflux-agent.2628883576.workers.dev/webhooks/github",
    active: true,
  },
  redirect_url: `${origin}/callback`,
  setup_url: "https://github.com/Conflux-Union/conflux-agent",
  public: false,
  default_permissions: {
    contents: "read",
    issues: "write",
    members: "read",
    metadata: "read",
    pull_requests: "write",
  },
  default_events: [
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
  ],
};

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Conflux Agent</title></head><body>${body}</body></html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", origin);
  if (url.pathname === "/") {
    const escapedManifest = JSON.stringify(manifest).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      html(`<h1>Create Conflux Agent</h1><p>GitHub will show the requested permissions before creation.</p><form action="https://github.com/organizations/Conflux-Union/settings/apps/new?state=${state}" method="post"><input type="hidden" name="manifest" value="${escapedManifest}"><button type="submit">Create GitHub App</button></form>`),
    );
    return;
  }
  if (url.pathname !== "/callback") {
    response.writeHead(404).end("Not found");
    return;
  }
  if (url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
    response.writeHead(400).end("Invalid callback state");
    return;
  }
  try {
    const conversion = await fetch(
      `https://api.github.com/app-manifests/${encodeURIComponent(url.searchParams.get("code"))}/conversions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Conflux-Agent-Setup",
          "X-GitHub-Api-Version": "2026-03-10",
        },
      },
    );
    if (!conversion.ok) throw new Error(`GitHub returned ${conversion.status}`);
    const credentials = await conversion.json();
    await writeFile(
      outputPath,
      JSON.stringify(
        {
          id: credentials.id,
          slug: credentials.slug,
          html_url: credentials.html_url,
          pem: credentials.pem,
          webhook_secret: credentials.webhook_secret,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await chmod(outputPath, 0o600);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html("<h1>Conflux Agent created</h1><p>Credentials were captured securely. You can close this tab.</p>"));
    process.stdout.write("GitHub App manifest conversion completed.\n");
    setTimeout(() => server.close(), 250);
  } catch (error) {
    response.writeHead(500).end("Manifest conversion failed");
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${origin}/\n`);
});
