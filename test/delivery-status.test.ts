import { describe, expect, it } from "vitest";
import {
  deliveryFailureAction,
  deliveryFailureStatus,
} from "../src/delivery-status";
import type { RepositoryEvent } from "../src/domain";

const event = {
  deliveryId: "80408e2e-9658-11f1-8328-445cae821d78",
  repository: { owner: "Conflux-Union", repo: "conflux-map" },
  item: { number: 43 },
} as RepositoryEvent;

describe("deliveryFailureStatus", () => {
  it("records a bounded single-line reason without secrets", () => {
    const status = deliveryFailureStatus(
      new Error(`Model request failed with 400:\ninvalid sk-${"a".repeat(48)}`),
    );
    expect(status).toBe("failed:Error: Model request failed with 400: invalid [REDACTED]");
    expect(status.length).toBeLessThanOrEqual(500);
  });

  it("creates an idempotent failure comment with the sanitized reason", () => {
    const action = deliveryFailureAction(
      event,
      new Error(`Model request failed with 400:\ninvalid sk-${"a".repeat(48)}`),
    );

    expect(action.id).toBe("failure-80408e2e965811f1");
    expect(action.kind).toBe("comment");
    expect(action.target).toEqual({
      owner: "Conflux-Union",
      repo: "conflux-map",
      number: 43,
    });
    expect(action.parameters.body).toBe(
      "Conflux Agent could not finish processing this event after 3 attempts.\n\n" +
        "Error: `Error: Model request failed with 400: invalid [REDACTED]`",
    );
  });
});
