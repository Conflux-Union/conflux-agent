import { z } from "zod";

const metadataMappingSchema = z.object({
  label: z.string().min(1),
  fieldValue: z.string().min(1),
  canonical: z.boolean().default(false),
  titlePrefix: z.string().min(1).optional(),
});

const automaticActionsSchema = z.object({
  metadata: z.boolean().default(true),
  conversation: z.boolean().default(true),
  closingLinks: z.boolean().default(true),
  duplicate: z.boolean().default(false),
  wontfix: z.boolean().default(false),
  assignment: z.boolean().default(false),
});

export const repositoryConfigSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean().default(true),
  languages: z.array(z.string()).min(1).default(["en"]),
  repository: z.object({
    description: z.string().min(1),
    defaultBranch: z.string().min(1),
  }),
  search: z.object({
    repositories: z.array(z.string()).default([]),
    maxCandidates: z.number().int().min(1).max(20).default(10),
    maxDeepComparisons: z.number().int().min(1).max(5).default(3),
  }),
  metadata: z.object({
    issueTypes: z.record(z.string(), metadataMappingSchema).default({}),
    priorities: z.record(z.string(), metadataMappingSchema).default({}),
    priorityFieldId: z.number().int().positive().optional(),
    projectId: z.string().min(1).optional(),
  }),
  areas: z
    .array(
      z.object({
        label: z.string().min(1),
        paths: z.array(z.string()).default([]),
        assignees: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  autonomy: z.object({
    automatic: automaticActionsSchema,
    minimumConfidence: z.number().min(0).max(1).default(0.9),
    duplicateMinimumConfidence: z.number().min(0).max(1).default(0.88),
    assignment: z
      .object({
        historyDepth: z.number().int().min(5).max(100).default(30),
        minimumCommits: z.number().int().min(1).max(20).default(3),
        minimumShare: z.number().min(0.5).max(1).default(0.6),
        minimumLead: z.number().int().min(1).max(20).default(2),
      })
      .default({
        historyDepth: 30,
        minimumCommits: 3,
        minimumShare: 0.6,
        minimumLead: 2,
      }),
    trustedAssociations: z
      .array(z.enum(["OWNER", "MEMBER", "COLLABORATOR"]))
      .default(["OWNER", "MEMBER", "COLLABORATOR"]),
  }),
  budgets: z.object({
    maxModelCallsPerEvent: z.number().int().min(1).max(4).default(2),
    maxInputCharacters: z.number().int().min(1000).max(100_000).default(30_000),
    maxOutputTokens: z.number().int().min(100).max(8000).default(2500),
  }),
  disabledLabels: z.array(z.string()).default(["agent/disabled"]),
});

export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;
