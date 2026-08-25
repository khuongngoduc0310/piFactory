import { assertNonEmptyString, freezeStrings } from "./validation.js";
import { DomainError } from "./domain-error.js";

export const ARTIFACT_TYPES = [
  "plan",
  "exploration",
  "implementation",
  "diagnosis",
  "test",
  "integration",
  "review",
  "baseline",
  "human_decision",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface Artifact {
  readonly id: string;
  readonly type: ArtifactType;
  readonly workNodeId?: string;
  readonly summary: string;
  readonly facts: readonly string[];
  readonly assumptions: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly digest: string;
}

export interface CreateArtifactInput {
  readonly id: string;
  readonly type: ArtifactType;
  readonly workNodeId?: string;
  readonly summary: string;
  readonly facts: readonly string[];
  readonly assumptions: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly digest: string;
}

export function createArtifact(input: CreateArtifactInput): Artifact {
  assertNonEmptyString(input.id, "Artifact id");
  assertNonEmptyString(input.summary, "Artifact summary");
  assertNonEmptyString(input.digest, "Artifact digest");
  if (!(ARTIFACT_TYPES as readonly string[]).includes(input.type)) {
    throw new DomainError("invalid_argument", "Artifact type is not supported");
  }
  if (input.workNodeId !== undefined) {
    assertNonEmptyString(input.workNodeId, "Artifact workNodeId");
  }

  return Object.freeze({
    id: input.id,
    type: input.type,
    ...(input.workNodeId === undefined ? {} : { workNodeId: input.workNodeId }),
    summary: input.summary,
    facts: freezeStrings(input.facts, "Artifact facts"),
    assumptions: freezeStrings(input.assumptions, "Artifact assumptions"),
    unresolvedQuestions: freezeStrings(
      input.unresolvedQuestions,
      "Artifact unresolvedQuestions",
    ),
    evidenceRefs: freezeStrings(input.evidenceRefs, "Artifact evidenceRefs"),
    ...(input.changedFiles === undefined
      ? {}
      : { changedFiles: freezeStrings(input.changedFiles, "Artifact changedFiles") }),
    digest: input.digest,
  });
}
