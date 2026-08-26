import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assessMutationScope,
  captureWorkspaceSnapshot,
  createMutationScope,
  createWorkspaceSnapshot,
  parseRepositoryPath,
  sha256Utf8,
} from "../../src/workspace/index.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function file(path: string, value: string, mode: "100644" | "100755" = "100644") {
  return {
    path: parseRepositoryPath(path),
    kind: "file" as const,
    mode,
    contentDigest: sha256Utf8(value),
  };
}

function link(path: string, target: string) {
  return {
    path: parseRepositoryPath(path),
    kind: "symlink" as const,
    mode: "120000" as const,
    target,
  };
}

describe("mutation boundaries", () => {
  it("authorizes exact paths and descendants while forbidden paths win", () => {
    const before = createWorkspaceSnapshot([
      file("src/allowed.ts", "old"),
      file("src/blocked/old.ts", "old"),
      file("src/other.ts", "old"),
      file("mode.sh", "same"),
      link("link", "old"),
    ]);
    const after = createWorkspaceSnapshot([
      file("src/allowed.ts", "new"),
      file("src/blocked/old.ts", "new"),
      file("src/other.ts", "new"),
      file("mode.sh", "same", "100755"),
      link("link", "new"),
    ]);
    const scope = createMutationScope({
      allowedMutationPaths: ["src"],
      forbiddenPaths: ["src/blocked", "mode.sh"],
    });

    const assessment = assessMutationScope(before, after, scope);

    expect(assessment.accepted).toBe(false);
    expect(assessment.violations).toEqual([
      { path: "link", changeKind: "modified", reason: "outside_allowed_scope" },
      { path: "mode.sh", changeKind: "modified", reason: "explicitly_forbidden" },
      { path: "src/blocked/old.ts", changeKind: "modified", reason: "explicitly_forbidden" },
    ]);
  });

  it("fails closed when no mutation paths are granted, but accepts a no-op", () => {
    const before = createWorkspaceSnapshot([file("same.txt", "same")]);
    const after = createWorkspaceSnapshot([file("same.txt", "same")]);
    const scope = createMutationScope({ relevantPaths: ["same.txt"] });
    const noOp = assessMutationScope(before, after, scope);

    expect(noOp).toEqual({ accepted: true, violations: [] });

    const changed = createWorkspaceSnapshot([file("same.txt", "changed")]);
    expect(assessMutationScope(before, changed, scope)).toEqual({
      accepted: false,
      violations: [
        { path: "same.txt", changeKind: "modified", reason: "outside_allowed_scope" },
      ],
    });
  });

  it("reports all violations in deterministic order and avoids prefix confusion", () => {
    const before = createWorkspaceSnapshot([]);
    const after = createWorkspaceSnapshot([
      file("src/authentication.ts", "new"),
      file("src/other.ts", "new"),
    ]);
    const assessment = assessMutationScope(
      before,
      after,
      createMutationScope({ allowedMutationPaths: ["src/auth"] }),
    );

    expect(assessment.violations.map(({ path }) => path)).toEqual([
      "src/authentication.ts",
      "src/other.ts",
    ]);
  });

  it("enforces scope for additions and deletions", () => {
    const before = createWorkspaceSnapshot([file("removed.txt", "old")]);
    const after = createWorkspaceSnapshot([file("created.txt", "new")]);
    const assessment = assessMutationScope(
      before,
      after,
      createMutationScope({ allowedMutationPaths: ["created.txt"] }),
    );

    expect(assessment).toEqual({
      accepted: false,
      violations: [
        { path: "removed.txt", changeKind: "deleted", reason: "outside_allowed_scope" },
      ],
    });
  });

  it("supports explicit case-insensitive scope matching", () => {
    const before = createWorkspaceSnapshot([]);
    const after = createWorkspaceSnapshot([file("SRC/Auth.ts", "new")]);
    const scope = createMutationScope(
      { allowedMutationPaths: ["src"] },
      { caseSensitivity: "insensitive" },
    );

    expect(assessMutationScope(before, after, scope).accepted).toBe(true);
  });

  it("uses custom path limits consistently through assessment", () => {
    const longPath = "x".repeat(300);
    const path = parseRepositoryPath(longPath, { limits: { maxSegmentBytes: 512 } });
    const after = createWorkspaceSnapshot(
      [{ path, kind: "file", mode: "100644", contentDigest: sha256Utf8("new") }],
      { limits: { maxSegmentBytes: 512 } },
    );
    const scope = createMutationScope(
      { allowedMutationPaths: [longPath] },
      { pathLimits: { maxSegmentBytes: 512 } },
    );

    expect(assessMutationScope(createWorkspaceSnapshot([]), after, scope)).toEqual({
      accepted: true,
      violations: [],
    });
  });

  it("supports a real before/after workspace attestation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifactory-phase3-attestation-"));
    directories.push(root);
    await writeFile(join(root, "allowed.txt"), "before", "utf8");
    await writeFile(join(root, "outside.txt"), "before", "utf8");
    const before = await captureWorkspaceSnapshot(root);

    await writeFile(join(root, "allowed.txt"), "after", "utf8");
    await writeFile(join(root, "outside.txt"), "after", "utf8");
    await chmod(join(root, "allowed.txt"), 0o755);
    const after = await captureWorkspaceSnapshot(root);
    const assessment = assessMutationScope(
      before,
      after,
      createMutationScope({ allowedMutationPaths: ["allowed.txt"] }),
    );

    expect(assessment.accepted).toBe(false);
    expect(assessment.violations).toEqual([
      { path: "outside.txt", changeKind: "modified", reason: "outside_allowed_scope" },
    ]);
  });

  it("rejects invalid scope and forged snapshot declarations before assessment", () => {
    expect(() => createMutationScope({ allowedMutationPaths: ["../outside"] })).toThrowError(
      expect.objectContaining({ code: "invalid_scope" }),
    );
    const scope = createMutationScope({ allowedMutationPaths: ["file.txt"] });
    const snapshot = createWorkspaceSnapshot([file("file.txt", "before")]);
    const forged = { ...snapshot, digest: sha256Utf8("forged") } as never;

    expect(() => assessMutationScope(forged, snapshot, scope)).toThrowError(
      expect.objectContaining({ code: "invalid_snapshot" }),
    );
  });

  it("rejects accessor-backed scope declarations", () => {
    const scope = createMutationScope({ allowedMutationPaths: ["file.txt"] });
    const accessorScope = { ...scope } as Record<string, unknown>;
    Object.defineProperty(accessorScope, "allowedMutationPaths", {
      enumerable: true,
      get: () => scope.allowedMutationPaths,
    });
    const before = createWorkspaceSnapshot([]);
    const after = createWorkspaceSnapshot([file("file.txt", "new")]);

    expect(() => assessMutationScope(before, after, accessorScope as never)).toThrowError(
      expect.objectContaining({ code: "invalid_scope" }),
    );
  });
});
