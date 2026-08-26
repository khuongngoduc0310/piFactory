export const WORKSPACE_ERROR_CODES = [
  "invalid_argument",
  "invalid_path",
  "invalid_digest",
  "unsupported_value",
  "invalid_snapshot",
  "invalid_delta",
  "invalid_scope",
  "unsafe_entry",
  "workspace_changed",
  "size_limit_exceeded",
  "io_failure",
] as const;

export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceError";
    this.code = code;
  }
}
