import { describe, expect, it } from "vitest";
import { parseWebhook, shouldIgnoreEvent, threadName } from "../src/webhook";

const payload = {
  action: "created",
  installation: { id: 42 },
  repository: {
    name: "conflux-map",
    default_branch: "master",
    owner: { login: "Conflux-Union" },
  },
  issue: {
    number: 36,
    node_id: "I_36",
    title: "Issue",
    body: "Body",
    state: "open",
    user: { login: "reporter" },
    labels: [{ name: "bug" }],
    updated_at: "2026-08-12T00:00:00Z",
  },
  comment: {
    id: 7,
    body: "More information",
    user: { login: "reporter" },
    author_association: "NONE",
    updated_at: "2026-08-12T00:00:00Z",
  },
  sender: { login: "reporter", type: "User" },
  label: { name: "bug" },
};

describe("parseWebhook", () => {
  it("normalizes an issue comment and produces a stable thread name", () => {
    const event = parseWebhook("issue_comment", "delivery", payload);
    expect(event?.comment?.body).toBe("More information");
    expect(event?.changedLabel).toBe("bug");
    expect(event && threadName(event)).toBe(
      "42:conflux-union:conflux-map:issue:36",
    );
  });

  it("ignores events created by bots", () => {
    const event = parseWebhook("issue_comment", "delivery", {
      ...payload,
      sender: { login: "conflux-agent[bot]", type: "Bot" },
    });
    expect(event && shouldIgnoreEvent(event)).toBe(true);
  });

  it("normalizes native issue field events", () => {
    const event = parseWebhook("issues", "field-delivery", {
      ...payload,
      action: "field_added",
      issue_field: { id: 33061222, name: "Priority" },
      issue_field_value: { single_select_option: { name: "High" } },
      changes: {
        issue_field_value: {
          from: { single_select_option: { name: "Medium" } },
        },
      },
    });
    expect(event?.changedField).toEqual({
      name: "Priority",
      value: "High",
      previousValue: "Medium",
    });
  });

  it("normalizes native issue type events", () => {
    const typed = parseWebhook("issues", "type-delivery", {
      ...payload,
      action: "typed",
      type: { name: "Bug" },
    });
    const untyped = parseWebhook("issues", "untyped-delivery", {
      ...payload,
      action: "untyped",
      type: null,
    });
    expect(typed?.changedField).toEqual({ name: "Type", value: "Bug" });
    expect(untyped?.changedField).toEqual({ name: "Type", value: undefined });
  });
});
