import { describe, expect, it } from "vitest";

import {
  createWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  parseRepositoryPath,
  sha256Utf8,
} from "../../src/workspace/index.js";

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

describe("workspace deltas", () => {
  it("derives sorted additions, modifications, and deletions", () => {
    const before = createWorkspaceSnapshot([
      file("deleted.txt", "old"),
      file("changed.txt", "old"),
      file("mode.sh", "same"),
      link("link", "old-target"),
    ]);
    const after = createWorkspaceSnapshot([
      file("added.txt", "new"),
      file("changed.txt", "new"),
      file("mode.sh", "same", "100755"),
      link("link", "new-target"),
    ]);

    const delta = diffWorkspaceSnapshots(before, after);

    expect(delta.changes.map(({ kind, path }) => `${kind}:${path}`)).toEqual([
      "added:added.txt",
      "modified:changed.txt",
      "deleted:deleted.txt",
      "modified:link",
      "modified:mode.sh",
    ]);
    expect(Object.isFrozen(delta)).toBe(true);
    expect(Object.isFrozen(delta.changes)).toBe(true);
  });

  it("represents a rename as a deletion and an addition", () => {
    const before = createWorkspaceSnapshot([file("old.txt", "same")]);
    const after = createWorkspaceSnapshot([file("new.txt", "same")]);

    expect(diffWorkspaceSnapshots(before, after).changes.map(({ kind, path }) => `${kind}:${path}`)).toEqual([
      "added:new.txt",
      "deleted:old.txt",
    ]);
  });

  it("uses the snapshot case policy when matching paths", () => {
    const before = createWorkspaceSnapshot([file("Foo.ts", "old")], {
      caseSensitivity: "insensitive",
    });
    const after = createWorkspaceSnapshot([file("foo.ts", "new")], {
      caseSensitivity: "insensitive",
    });

    expect(diffWorkspaceSnapshots(before, after).changes).toEqual([
      {
        kind: "modified",
        path: "foo.ts",
        before: file("Foo.ts", "old"),
        after: file("foo.ts", "new"),
      },
    ]);
  });

  it("carries custom validation limits through diffing", () => {
    const target = "x".repeat(300);
    const before = createWorkspaceSnapshot(
      [
        {
          path: parseRepositoryPath("link"),
          kind: "symlink",
          mode: "120000",
          target,
        },
      ],
      { limits: { maxSymlinkTargetBytes: 512 } },
    );
    const after = createWorkspaceSnapshot(
      [
        {
          path: parseRepositoryPath("link"),
          kind: "symlink",
          mode: "120000",
          target: `${target}!`,
        },
      ],
      { limits: { maxSymlinkTargetBytes: 512 } },
    );

    expect(diffWorkspaceSnapshots(before, after).changes).toHaveLength(1);
  });

  it("returns no changes for equal snapshots and rejects forged snapshots", () => {
    const snapshot = createWorkspaceSnapshot([file("same.txt", "same")]);
    expect(diffWorkspaceSnapshots(snapshot, snapshot).changes).toEqual([]);

    const forged = { ...snapshot, digest: sha256Utf8("forged") };
    expect(() => diffWorkspaceSnapshots(forged, snapshot)).toThrowError(
      expect.objectContaining({ code: "invalid_snapshot" }),
    );
  });

  it("materializes mutable snapshot input before building a delta", () => {
    const mutableEntry = file("created.txt", "created");
    const normalized = createWorkspaceSnapshot([mutableEntry]);
    const mutableSnapshot = { ...normalized, entries: [mutableEntry] } as never;
    const delta = diffWorkspaceSnapshots(createWorkspaceSnapshot([]), mutableSnapshot);

    mutableEntry.contentDigest = sha256Utf8("changed");

    expect(delta.changes[0]).toMatchObject({
      kind: "added",
      path: "created.txt",
      after: { contentDigest: sha256Utf8("created") },
    });
  });

  it("rejects accessor-backed snapshot fields", () => {
    const snapshot = createWorkspaceSnapshot([file("same.txt", "same")]);
    const accessorSnapshot = { ...snapshot } as Record<string, unknown>;
    Object.defineProperty(accessorSnapshot, "entries", {
      enumerable: true,
      get: () => snapshot.entries,
    });

    expect(() => diffWorkspaceSnapshots(accessorSnapshot as never, snapshot)).toThrowError(
      expect.objectContaining({ code: "invalid_snapshot" }),
    );
  });
});
