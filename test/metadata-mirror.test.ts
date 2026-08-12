import { describe, expect, it } from "vitest";
import { repositoryConfigSchema } from "../src/config";
import type { RepositoryEvent } from "../src/domain";
import {
  applyMetadataOverrides,
  metadataOverrideForEvent,
  planNativeMetadataMirror,
} from "../src/planner";

const config = repositoryConfigSchema.parse({
  version: 1,
  repository: { description: "Test", defaultBranch: "main" },
  search: {},
  metadata: {
    priorityFieldId: 744966,
    issueTypes: {
      enhancement: { label: "enhancement", fieldValue: "Task", canonical: true },
      question: { label: "question", fieldValue: "Task" },
    },
    priorities: {
      P3: { label: "P3", fieldValue: "Low", canonical: true },
      P4: { label: "P4", fieldValue: "Low" },
    },
  },
  autonomy: { automatic: {} },
  budgets: {},
});

describe("metadata overrides", () => {
  it("preserves an explicit human clear until content is reconsidered", () => {
    const unlabeled = event([]);
    unlabeled.action = "unlabeled";
    unlabeled.changedField = undefined;
    unlabeled.changedLabel = "P3";
    const override = metadataOverrideForEvent(unlabeled, config);
    expect(override).not.toBeNull();
    expect(
      applyMetadataOverrides(
        { issueKind: "enhancement", priority: "P3", areaLabels: [] },
        [override!],
      ),
    ).toEqual({ issueKind: "enhancement", priority: undefined, areaLabels: [] });
  });
});

function event(labels: string[]): RepositoryEvent {
  return {
    deliveryId: "delivery",
    eventName: "issues",
    action: "field_added",
    repository: { installationId: 1, owner: "Org", repo: "Repo", defaultBranch: "main" },
    item: {
      kind: "issue",
      number: 1,
      title: "Issue",
      body: "",
      state: "open",
      author: "author",
      assignees: [],
      labels,
      updatedAt: "2026-08-12T00:00:00Z",
    },
    sender: { login: "maintainer", type: "User" },
    changedField: { name: "Priority", value: "Low" },
  };
}

describe("planNativeMetadataMirror", () => {
  it("preserves an existing non-canonical label for a many-to-one field value", async () => {
    expect(await planNativeMetadataMirror(event(["P4"]), config)).toEqual([]);
  });

  it("uses the canonical label when the native field is the first value", async () => {
    const actions = await planNativeMetadataMirror(event([]), config);
    expect(actions[0]?.parameters).toEqual({ add: ["P3"], remove: [] });
  });

  it("removes managed labels when the native field is cleared", async () => {
    const cleared = event(["P4"]);
    cleared.action = "field_removed";
    cleared.changedField = { name: "Priority" };
    const actions = await planNativeMetadataMirror(cleared, config);
    expect(actions[0]?.parameters).toEqual({ add: [], remove: ["P4"] });
  });

  it("clears native metadata when the final managed labels are removed", async () => {
    const unlabeled = event([]);
    unlabeled.action = "unlabeled";
    unlabeled.changedField = undefined;
    unlabeled.changedLabel = "P3";
    const actions = await import("../src/planner").then(({ planLabelMetadataMirror }) =>
      planLabelMetadataMirror(unlabeled, config),
    );
    expect(actions.map((action) => action.kind)).toEqual(["clear_issue_field"]);
  });

  it("does not clear native metadata when an unrelated label is removed", async () => {
    const unlabeled = event([]);
    unlabeled.action = "unlabeled";
    unlabeled.changedField = undefined;
    unlabeled.changedLabel = "area/client";

    const actions = await import("../src/planner").then(({ planLabelMetadataMirror }) =>
      planLabelMetadataMirror(unlabeled, config),
    );
    expect(actions).toEqual([]);
  });

  it("treats the latest managed label as authoritative and removes conflicts", async () => {
    const labeled = event(["P3", "P4"]);
    labeled.action = "labeled";
    labeled.changedField = undefined;
    labeled.changedLabel = "P4";

    const actions = await import("../src/planner").then(({ planLabelMetadataMirror }) =>
      planLabelMetadataMirror(labeled, config),
    );
    expect(actions.map((action) => action.kind)).toEqual([
      "set_labels",
      "set_issue_field",
    ]);
    expect(actions[0]?.parameters).toEqual({ add: [], remove: ["P3"] });
    expect(actions[1]?.parameters.value).toBe("Low");
  });
});
