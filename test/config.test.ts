import { describe, expect, it } from "vitest";
import { repositoryConfigSchema } from "../src/config";

const baseConfig = {
  version: 1 as const,
  repository: {
    description: "Test repository",
    defaultBranch: "master",
  },
  search: {},
  metadata: {},
  autonomy: {
    automatic: {},
  },
  disabledLabels: [],
};

describe("repositoryConfigSchema", () => {
  it("allows up to 30 model calls per event", () => {
    const config = repositoryConfigSchema.parse({
      ...baseConfig,
      budgets: { maxModelCallsPerEvent: 30 },
    });

    expect(config.budgets.maxModelCallsPerEvent).toBe(30);
  });

  it("rejects more than 30 model calls per event", () => {
    expect(() =>
      repositoryConfigSchema.parse({
        ...baseConfig,
        budgets: { maxModelCallsPerEvent: 31 },
      }),
    ).toThrow();
  });
});
