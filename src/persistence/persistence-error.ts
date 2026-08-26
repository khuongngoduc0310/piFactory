export const PERSISTENCE_ERROR_CODES = [
  "not_found",
  "already_exists",
  "stale_state_version",
  "corrupt_state",
  "unsupported_schema",
  "identity_mismatch",
  "unsafe_storage_entry",
  "size_limit_exceeded",
  "invalid_argument",
  "invalid_event",
  "io_failure",
] as const;

export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersistenceError";
    this.code = code;
  }
}
