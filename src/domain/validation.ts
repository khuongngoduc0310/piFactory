import { DomainError } from "./domain-error.js";

export function assertNonEmptyString(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("invalid_argument", `${field} must be a non-empty string`);
  }
}

export function assertIsoTimestamp(value: string, field: string): void {
  assertNonEmptyString(value, field);
  if (!isIsoTimestamp(value)) {
    throw new DomainError(
      "invalid_argument",
      `${field} must be a canonical UTC ISO-8601 timestamp`,
    );
  }
}

export function isIsoTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function assertTimestampNotBefore(
  value: string,
  previous: string,
  field: string,
): void {
  assertIsoTimestamp(value, field);
  if (Date.parse(value) < Date.parse(previous)) {
    throw new DomainError("invalid_argument", `${field} cannot move backwards`);
  }
}

export function freezeStrings(
  values: readonly string[],
  field: string,
): readonly string[] {
  if (!Array.isArray(values)) {
    throw new DomainError("invalid_argument", `${field} must be an array`);
  }
  for (const value of values) {
    assertNonEmptyString(value, `${field} entry`);
  }
  return Object.freeze([...values]);
}

export function freezeUniqueSortedStrings(
  values: readonly string[],
  field: string,
): readonly string[] {
  return Object.freeze([...new Set(freezeStrings(values, field))].sort());
}
