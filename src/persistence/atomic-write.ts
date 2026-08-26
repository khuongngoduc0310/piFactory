import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { PersistenceError } from "./persistence-error.js";

export interface AtomicWriteOptions {
  readonly mode?: number;
  readonly beforeRename?: () => void | Promise<void>;
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  const code = error.code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EPERM";
}

export async function flushDirectory(directoryPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) {
      throw new PersistenceError(
        "io_failure",
        `Could not flush directory ${directoryPath}`,
        { cause: error },
      );
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function atomicWriteFile(
  filePath: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directoryPath = dirname(filePath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", options.mode ?? 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforeRename?.();
    await rename(temporaryPath, filePath);
    await flushDirectory(directoryPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof PersistenceError) {
      throw error;
    }
    throw new PersistenceError("io_failure", `Could not atomically write ${filePath}`, {
      cause: error,
    });
  }
}
