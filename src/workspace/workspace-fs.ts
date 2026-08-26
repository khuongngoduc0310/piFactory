import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import type { Dir, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export interface WorkspaceFileSystem {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly open: (path: string, flags: string | number) => Promise<FileHandle>;
  readonly opendir: (
    path: string,
    options?: { readonly bufferSize?: number; readonly encoding?: "buffer" },
  ) => Promise<Dir>;
  readonly readlink: (path: string, options: { readonly encoding: "buffer" }) => Promise<Buffer>;
  readonly realpath: (path: string) => Promise<string>;
}

export const NODE_WORKSPACE_FILE_SYSTEM: WorkspaceFileSystem = Object.freeze({
  lstat,
  open,
  opendir: (
    path: string,
    options?: { readonly bufferSize?: number; readonly encoding?: "buffer" },
  ) => opendir(path, options as Parameters<typeof opendir>[1]),
  readlink,
  realpath,
});
