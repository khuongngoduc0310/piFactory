import {
  chmod,
  link as createHardLink,
  mkdtemp,
  mkdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureWorkspaceSnapshot,
  createWorkspaceSnapshot,
  parseRepositoryPath,
  sha256Bytes,
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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pifactory-phase3-"));
  directories.push(directory);
  return directory;
}

describe("workspace snapshots", () => {
  it("captures binary and text files in deterministic path order", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "z-dir"));
    await mkdir(join(root, "a-dir"));
    await writeFile(join(root, "z-dir", "text.txt"), "hello", "utf8");
    const binary = Uint8Array.from([0, 1, 2, 255]);
    await writeFile(join(root, "a-dir", "binary.bin"), binary);

    const snapshot = await captureWorkspaceSnapshot(root);

    expect(snapshot.entries.map(({ path }) => path)).toEqual([
      "a-dir/binary.bin",
      "z-dir/text.txt",
    ]);
    expect(snapshot.entries[0]).toMatchObject({
      kind: "file",
      mode: "100644",
      contentDigest: sha256Bytes(binary),
    });
    expect(snapshot.entries[1]).toMatchObject({
      kind: "file",
      contentDigest: sha256Utf8("hello"),
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
  });

  it("accepts a valid Unicode replacement-character filename", async () => {
    const root = await temporaryDirectory();
    const filename = "replacement-\ufffd.txt";
    await writeFile(join(root, filename), "value", "utf8");

    const snapshot = await captureWorkspaceSnapshot(root);

    expect(snapshot.entries.map(({ path }) => path)).toEqual([filename]);
  });

  it("uses explicit normalized modes and detects an executable bit on POSIX", async () => {
    const root = await temporaryDirectory();
    const file = join(root, "script.sh");
    await writeFile(file, "#!/bin/sh\n", "utf8");
    await chmod(file, 0o755);

    const snapshot = await captureWorkspaceSnapshot(root);
    const expectedMode = process.platform === "win32" ? "100644" : "100755";

    expect(snapshot.entries[0]).toMatchObject({ path: "script.sh", mode: expectedMode });
  });

  it("rejects files and snapshots that exceed configured limits", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "large.txt"), "12345", "utf8");

    await expect(
      captureWorkspaceSnapshot(root, { limits: { maxFileBytes: 4 } }),
    ).rejects.toMatchObject({ code: "size_limit_exceeded" });
    expect(() =>
      createWorkspaceSnapshot(
        [
          {
            path: "large.txt" as never,
            kind: "file",
            mode: "100644",
            contentDigest: sha256Utf8("large"),
          },
        ],
        { limits: { maxCanonicalBytes: 1 } },
      ),
    ).toThrowError(expect.objectContaining({ code: "size_limit_exceeded" }));
  });

  it("applies maxDepth to files and symlinks as well as directories", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "root.txt"), "root", "utf8");
    await mkdir(join(root, "nested"));

    await expect(
      captureWorkspaceSnapshot(root, { limits: { maxDepth: 1 } }),
    ).resolves.toMatchObject({ entries: [{ path: "root.txt" }] });

    await writeFile(join(root, "nested", "child.txt"), "child", "utf8");
    await expect(
      captureWorkspaceSnapshot(root, { limits: { maxDepth: 1 } }),
    ).rejects.toMatchObject({ code: "size_limit_exceeded" });
  });

  it("applies maxDepth when validating constructed snapshots", () => {
    expect(() =>
      createWorkspaceSnapshot(
        [
          {
            path: parseRepositoryPath("nested/file.txt"),
            kind: "file",
            mode: "100644",
            contentDigest: sha256Utf8("value"),
          },
        ],
        { limits: { maxDepth: 1 } },
      ),
    ).toThrowError(expect.objectContaining({ code: "size_limit_exceeded" }));
  });

  it("supports custom path limits larger than the default canonical string limit", () => {
    const longPath = "x".repeat(1_024 * 1_024 + 1);
    const path = parseRepositoryPath(longPath, {
      limits: { maxPathBytes: longPath.length, maxSegmentBytes: longPath.length },
    });

    const snapshot = createWorkspaceSnapshot(
      [{ path, kind: "file", mode: "100644", contentDigest: sha256Utf8("value") }],
      { limits: { maxPathBytes: longPath.length, maxSegmentBytes: longPath.length } },
    );

    expect(snapshot.entries[0]?.path).toBe(longPath);
  });

  it("bounds directory enumeration and rejects hard-linked files", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "directory"));
    await writeFile(join(root, "directory", "one.txt"), "one", "utf8");
    await writeFile(join(root, "directory", "two.txt"), "two", "utf8");
    await expect(
      captureWorkspaceSnapshot(root, { limits: { maxDirectoryEntries: 1 } }),
    ).rejects.toMatchObject({ code: "size_limit_exceeded" });

    const hardLinkTarget = join(root, "hard-target.txt");
    const hardLinkPath = join(root, "hard-link.txt");
    await writeFile(hardLinkTarget, "shared", "utf8");
    await createHardLink(hardLinkTarget, hardLinkPath);
    await expect(captureWorkspaceSnapshot(root)).rejects.toMatchObject({ code: "unsafe_entry" });
  });

  it("records internal symlinks without traversing them", async (context) => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "target.txt"), "target", "utf8");
    try {
      await symlink("target.txt", join(root, "link.txt"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip();
        return;
      }
      throw error;
    }

    const snapshot = await captureWorkspaceSnapshot(root);
    const link = snapshot.entries.find(({ path }) => path === "link.txt");

    expect(link).toMatchObject({ kind: "symlink", mode: "120000", target: "target.txt" });
    expect(await readlink(join(root, "link.txt"))).toBe("target.txt");
  });

  it("rejects an escaping symlink", async (context) => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    try {
      await symlink(outside, join(root, "escape"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(captureWorkspaceSnapshot(root)).rejects.toMatchObject({ code: "unsafe_entry" });
  });

  it("rejects a dangling symlink", async (context) => {
    const root = await temporaryDirectory();
    try {
      await symlink("missing", join(root, "dangling"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(captureWorkspaceSnapshot(root)).rejects.toMatchObject({ code: "unsafe_entry" });
  });
});
