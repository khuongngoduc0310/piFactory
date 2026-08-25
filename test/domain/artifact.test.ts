import { describe, expect, it } from "vitest";

import { createArtifact } from "../../src/domain/artifact.js";
import { DomainError } from "../../src/domain/domain-error.js";

describe("createArtifact", () => {
  it("creates an immutable defensive copy", () => {
    const facts = ["Implemented the requested behavior"];
    const changedFiles = ["src/example.ts"];

    const artifact = createArtifact({
      id: "artifact-1",
      type: "implementation",
      workNodeId: "node-1",
      summary: "Implementation complete",
      facts,
      assumptions: [],
      unresolvedQuestions: [],
      evidenceRefs: ["test:unit"],
      changedFiles,
      digest: "opaque-digest",
    });

    facts.push("Mutated by caller");
    changedFiles.push("package.json");

    expect(artifact.facts).toEqual(["Implemented the requested behavior"]);
    expect(artifact.changedFiles).toEqual(["src/example.ts"]);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.facts)).toBe(true);
    expect(Object.isFrozen(artifact.changedFiles)).toBe(true);
  });

  it.each([
    ["id", { id: "" }],
    ["summary", { summary: " " }],
    ["digest", { digest: "" }],
    ["fact", { facts: [""] }],
  ])("rejects an invalid %s", (_field, override) => {
    expect(() =>
      createArtifact({
        id: "artifact-1",
        type: "test",
        summary: "Tests passed",
        facts: [],
        assumptions: [],
        unresolvedQuestions: [],
        evidenceRefs: [],
        digest: "opaque-digest",
        ...override,
      }),
    ).toThrow(DomainError);
  });

  it("rejects unsupported artifact types at runtime", () => {
    expect(() =>
      createArtifact({
        id: "artifact-1",
        type: "unsupported",
        summary: "Invalid artifact",
        facts: [],
        assumptions: [],
        unresolvedQuestions: [],
        evidenceRefs: [],
        digest: "opaque-digest",
      } as unknown as Parameters<typeof createArtifact>[0]),
    ).toThrow(DomainError);
  });
});
