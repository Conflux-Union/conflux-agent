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
  it("accepts the repository maintainers to mention for unanswered questions", () => {
    const config = repositoryConfigSchema.parse({
      ...baseConfig,
      repository: {
        ...baseConfig.repository,
        maintainers: ["Trirrin", "map-maintainer"],
      },
      budgets: {},
    });

    expect(config.repository.maintainers).toEqual(["Trirrin", "map-maintainer"]);
  });

  it("rejects values that are not GitHub login names", () => {
    expect(() =>
      repositoryConfigSchema.parse({
        ...baseConfig,
        repository: {
          ...baseConfig.repository,
          maintainers: ["@all maintainers"],
        },
        budgets: {},
      }),
    ).toThrow();
  });

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
