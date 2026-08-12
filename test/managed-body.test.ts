import { describe, expect, it } from "vitest";
import { readClosingLinks, updateClosingLinks } from "../src/managed-body";

describe("managed pull request body links", () => {
  it("appends a managed block without changing author content", () => {
    const result = updateClosingLinks("Author text\n", [27]);
    expect(result).toContain("Author text\n\n<!-- conflux-agent:links:start -->");
    expect(readClosingLinks(result)).toEqual([27]);
  });

  it("updates the managed block idempotently and sorts links", () => {
    const first = updateClosingLinks("Body", [27]);
    const second = updateClosingLinks(first, [36, 27, 36]);
    expect(second.match(/conflux-agent:links:start/g)).toHaveLength(1);
    expect(readClosingLinks(second)).toEqual([27, 36]);
    expect(updateClosingLinks(second, [36, 27])).toBe(second);
  });
});
