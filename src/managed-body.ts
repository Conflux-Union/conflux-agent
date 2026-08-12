const START = "<!-- conflux-agent:links:start -->";
const END = "<!-- conflux-agent:links:end -->";

export function updateClosingLinks(body: string, issueNumbers: number[]): string {
  const unique = [...new Set(issueNumbers)].sort((left, right) => left - right);
  const block = `${START}\n${unique.map((number) => `Closes #${number}`).join("\n")}\n${END}`;
  const pattern = new RegExp(`${START}[\\s\\S]*?${END}`, "m");
  if (pattern.test(body)) return body.replace(pattern, block);
  const trimmed = body.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

export function readClosingLinks(body: string): number[] {
  const pattern = new RegExp(`${START}([\\s\\S]*?)${END}`, "m");
  const match = body.match(pattern);
  if (!match?.[1]) return [];
  return [...match[1].matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map(
    (entry) => Number(entry[1]),
  );
}
