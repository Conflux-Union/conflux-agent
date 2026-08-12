import { expect, it } from "vitest";
import { acknowledgeAndExplore } from "../src/exploration";

it("adds the eyes reaction before model exploration starts", async () => {
  const events: string[] = [];
  const result = await acknowledgeAndExplore(
    {
      addEyesReaction: async () => {
        events.push("reaction");
      },
    },
    { owner: "Org", repo: "Repo", number: 39 },
    async () => {
      events.push("model");
      return "decision";
    },
  );

  expect(events).toEqual(["reaction", "model"]);
  expect(result).toBe("decision");
});
