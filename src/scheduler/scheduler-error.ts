export const SCHEDULER_ERROR_CODES = [
  "unsupported_run_state",
  "unsupported_budget",
] as const;

export type SchedulerErrorCode = (typeof SCHEDULER_ERROR_CODES)[number];

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;

  constructor(code: SchedulerErrorCode, message: string) {
    super(message);
    this.name = "SchedulerError";
    this.code = code;
  }
}
