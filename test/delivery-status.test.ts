import { describe, expect, it } from "vitest";
import { deliveryFailureStatus } from "../src/delivery-status";

describe("deliveryFailureStatus", () => {
  it("records a bounded single-line reason without secrets", () => {
    const status = deliveryFailureStatus(
      new Error(`Model request failed with 400:\ninvalid sk-${"a".repeat(48)}`),
    );
    expect(status).toBe("failed:Error: Model request failed with 400: invalid [REDACTED]");
    expect(status.length).toBeLessThanOrEqual(500);
  });
});
