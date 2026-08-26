import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureWorkspaceSnapshotWithFileSystem,
} from "../../src/workspace/workspace-snapshot.js";
import {
  NODE_WORKSPACE_FILE_SYSTEM,
  type WorkspaceFileSystem,
} from "../../src/workspace/workspace-fs.js";

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
  const directory = await mkdtemp(join(tmpdir(), "pifactory-phase3-race-"));
  directories.push(directory);
  return directory;
}

function withLstatHook(
  shouldHook: (path: string) => boolean,
  hook: (path: string) => Promise<void>,
): WorkspaceFileSystem {
  let triggered = false;
  return {
    ...NODE_WORKSPACE_FILE_SYSTEM,
    lstat: async (path) => {
      const stats = await NODE_WORKSPACE_FILE_SYSTEM.lstat(path);
      if (!triggered && shouldHook(path)) {
        triggered = true;
        await hook(path);
      }
      return stats;
    },
  };
}

function withPostHashOpenHook(
  targetPath: string,
  hook: () => Promise<void>,
): WorkspaceFileSystem {
  let targetOpened = false;
  return {
    ...NODE_WORKSPACE_FILE_SYSTEM,
    open: async (path, flags) => {
      const handle = await NODE_WORKSPACE_FILE_SYSTEM.open(path, flags);
      if (path !== targetPath || targetOpened) {
        return handle;
      }
      targetOpened = true;
      let statCalls = 0;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "stat") {
            return async (...args: Parameters<FileHandle["stat"]>) => {
              const stats = await target.stat(...args);
              statCalls += 1;
              if (statCalls === 2) {
                await target.close();
                await hook();
              }
              return stats;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as FileHandle;
    },
  };
}

describe("workspace snapshot race handling", () => {
  it("rejects a parent-directory replacement after its identity is checked", async () => {
    const root = await temporaryDirectory();
    const parent = join(root, "parent");
    const replacement = join(root, "replacement");
    await mkdir(parent);
    await mkdir(replacement);
    await writeFile(join(parent, "marker.txt"), "original", "utf8");
    await writeFile(join(replacement, "marker.txt"), "replacement", "utf8");

    const fileSystem = withLstatHook(
      (path) => path === parent,
      async () => {
        await rename(parent, join(root, "parent-original"));
        await rename(replacement, parent);
      },
    );

    await expect(captureWorkspaceSnapshotWithFileSystem(root, {}, fileSystem)).rejects.toMatchObject({
      code: "workspace_changed",
    });
  });

  it("rejects a persistent nested-directory change after that directory was scanned", async () => {
    const root = await temporaryDirectory();
    const nested = join(root, "a-dir");
    const trigger = join(root, "trigger.txt");
    await mkdir(nested);
    await writeFile(join(nested, "initial.txt"), "initial", "utf8");
    await writeFile(trigger, "trigger", "utf8");

    const fileSystem = withLstatHook(
      (path) => path === trigger,
      async () => {
        await writeFile(join(nested, "late.txt"), "late", "utf8");
      },
    );

    await expect(captureWorkspaceSnapshotWithFileSystem(root, {}, fileSystem)).rejects.toMatchObject({
      code: "workspace_changed",
    });
  });

  it("checks the pathname identity after hashing", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "target.txt");
    const replacement = join(root, "replacement.txt");
    await writeFile(target, "original", "utf8");
    await writeFile(replacement, "replacement", "utf8");

    const fileSystem = withPostHashOpenHook(target, async () => {
      await rename(target, join(root, "target-original.txt"));
      await rename(replacement, target);
    });

    await expect(captureWorkspaceSnapshotWithFileSystem(root, {}, fileSystem)).rejects.toMatchObject({
      code: "workspace_changed",
    });
  });
});
