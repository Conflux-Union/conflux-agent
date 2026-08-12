import { describe, expect, it } from "vitest";
import { isClearlyOffTopicRequest, offTopicReply } from "../src/scope";

describe("repository scope guard", () => {
  it("rejects explicit entertainment requests without a model call", () => {
    expect(isClearlyOffTopicRequest("? 讲个冷笑话")).toBe(true);
    expect(isClearlyOffTopicRequest("Tell me a joke")).toBe(true);
  });

  it("does not block ordinary repository discussion", () => {
    expect(isClearlyOffTopicRequest("这个崩溃怎么复现？")).toBe(false);
    expect(isClearlyOffTopicRequest("点击讲个笑话按钮时崩溃了")).toBe(false);
    expect(isClearlyOffTopicRequest("Can this PR get another test?" )).toBe(false);
  });

  it("returns a short refusal in the human's language", () => {
    expect(offTopicReply("讲个笑话")).toContain("本仓库代码");
    expect(offTopicReply("Tell me a joke")).toContain("I only handle work");
  });
});
