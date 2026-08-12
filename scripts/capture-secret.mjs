import { createServer } from "node:http";
import { chmod, writeFile } from "node:fs/promises";

const outputPath = new URL("../.mimo-key", import.meta.url);
const port = 3211;

const server = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>MiMo key</title></head><body><h1>Configure MiMo key</h1><p>The key is sent only to this local machine and will not be displayed.</p><form method="post"><input type="password" name="key" autocomplete="off" required style="width:32rem"><button type="submit">Save securely</button></form></body></html>`);
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405).end("Method not allowed");
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const key = new URLSearchParams(body).get("key")?.trim();
  if (!key || key.length < 10 || key.includes("\n")) {
    response.writeHead(400).end("Invalid key");
    return;
  }
  await writeFile(outputPath, `${key}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><html><body><h1>MiMo key captured securely</h1><p>You can close this tab.</p></body></html>");
  process.stdout.write("MiMo key captured securely.\n");
  setTimeout(() => server.close(), 250);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`http://127.0.0.1:${port}/\n`);
});
