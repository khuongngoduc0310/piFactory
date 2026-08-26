import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { atomicWriteFile } from "../../src/persistence/atomic-write.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("atomicWriteFile", () => {
  it("creates and replaces complete files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pifactory-atomic-"));
    directories.push(directory);
    const filePath = join(directory, "state.json");

    await atomicWriteFile(filePath, "first");
    await atomicWriteFile(filePath, "second");

    expect(await readFile(filePath, "utf8")).toBe("second");
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-")).length).toBe(0);
  });

  it("keeps the old destination when publication fails before rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pifactory-atomic-"));
    directories.push(directory);
    const filePath = join(directory, "state.json");
    await atomicWriteFile(filePath, "old");

    await expect(
      atomicWriteFile(filePath, "new", {
        beforeRename: () => {
          throw new Error("injected failure");
        },
      }),
    ).rejects.toMatchObject({ code: "io_failure" });

    expect(await readFile(filePath, "utf8")).toBe("old");
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-")).length).toBe(0);
  });
});
