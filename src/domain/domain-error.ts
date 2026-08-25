export type DomainErrorCode =
  | "invalid_argument"
  | "invalid_state_transition"
  | "invalid_graph"
  | "node_not_found"
  | "dependency_not_completed"
  | "run_incomplete";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
