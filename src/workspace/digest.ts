import { createHash } from "node:crypto";

import { WorkspaceError } from "./workspace-error.js";
import { isWellFormedString } from "./text-validation.js";

export type Sha256Digest = string & { readonly __sha256Digest: unique symbol };

export interface CanonicalizationLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxArrayLength: number;
  readonly maxStringBytes: number;
  readonly maxOutputBytes: number;
}

export const DEFAULT_CANONICALIZATION_LIMITS: CanonicalizationLimits = Object.freeze({
  maxDepth: 64,
  maxEntries: 100_000,
  maxArrayLength: 100_000,
  maxStringBytes: 1 * 1_024 * 1_024,
  maxOutputBytes: 64 * 1_024 * 1_024,
});

const MAX_CANONICALIZATION_DEPTH = 1_024;

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function assertPositiveLimit(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkspaceError("invalid_argument", `${field} must be a positive safe integer`);
  }
}

function mergeLimits(custom: Partial<CanonicalizationLimits> | undefined): CanonicalizationLimits {
  const limits = Object.freeze({
    ...DEFAULT_CANONICALIZATION_LIMITS,
    ...(custom ?? {}),
  });
  assertPositiveLimit(limits.maxDepth, "Canonicalization maxDepth");
  assertPositiveLimit(limits.maxEntries, "Canonicalization maxEntries");
  assertPositiveLimit(limits.maxArrayLength, "Canonicalization maxArrayLength");
  assertPositiveLimit(limits.maxStringBytes, "Canonicalization maxStringBytes");
  assertPositiveLimit(limits.maxOutputBytes, "Canonicalization maxOutputBytes");
  if (limits.maxDepth > MAX_CANONICALIZATION_DEPTH) {
    throw new WorkspaceError("invalid_argument", "Canonicalization maxDepth exceeds its supported limit");
  }
  return limits;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function quotedStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0c || codeUnit === 0x0d) {
      bytes += 2;
    } else if (codeUnit < 0x20) {
      bytes += 6;
    } else if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function validateString(value: string, limits: CanonicalizationLimits): number {
  if (!isWellFormedString(value)) {
    throw new WorkspaceError("unsupported_value", "Canonical data contains malformed Unicode");
  }
  if (Buffer.byteLength(value, "utf8") > limits.maxStringBytes) {
    throw new WorkspaceError("size_limit_exceeded", "Canonical string exceeds its size limit");
  }
  return quotedStringByteLength(value);
}

function canonicalizeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new WorkspaceError("unsupported_value", "Canonical data contains a non-finite number");
  }
  const serialized = JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (serialized === undefined) {
    throw new WorkspaceError("unsupported_value", "Canonical number cannot be serialized");
  }
  return serialized;
}

interface CanonicalizationState {
  readonly limits: CanonicalizationLimits;
  readonly seen: Set<object>;
  readonly chunks: string[];
  entries: number;
  outputBytes: number;
}

function countEntry(state: CanonicalizationState): void {
  state.entries += 1;
  if (state.entries > state.limits.maxEntries) {
    throw new WorkspaceError("size_limit_exceeded", "Canonical data contains too many entries");
  }
}

function append(state: CanonicalizationState, text: string, bytes = Buffer.byteLength(text, "utf8")): void {
  if (bytes > state.limits.maxOutputBytes - state.outputBytes) {
    throw new WorkspaceError("size_limit_exceeded", "Canonical serialization exceeds its size limit");
  }
  state.chunks.push(text);
  state.outputBytes += bytes;
}

function appendQuotedString(state: CanonicalizationState, value: string): void {
  const bytes = validateString(value, state.limits);
  if (bytes > state.limits.maxOutputBytes - state.outputBytes) {
    throw new WorkspaceError("size_limit_exceeded", "Canonical serialization exceeds its size limit");
  }
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text, "utf8") !== bytes) {
    throw new WorkspaceError("unsupported_value", "Canonical string cannot be serialized");
  }
  append(state, text, bytes);
}

function appendPrimitive(state: CanonicalizationState, value: string): void {
  append(state, value, Buffer.byteLength(value, "utf8"));
}

function assertArrayShape(value: readonly unknown[], state: CanonicalizationState): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new WorkspaceError("unsupported_value", "Canonical arrays must use the standard array prototype");
  }
  if (value.length > state.limits.maxArrayLength) {
    throw new WorkspaceError("size_limit_exceeded", "Canonical array exceeds its size limit");
  }
  const ownNames = Object.getOwnPropertyNames(value);
  const expectedNames = new Set<string>(["length"]);
  for (let index = 0; index < value.length; index += 1) {
    expectedNames.add(String(index));
  }
  if (
    ownNames.length !== expectedNames.size ||
    ownNames.some((name) => !expectedNames.has(name)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new WorkspaceError("unsupported_value", "Canonical array has unsupported properties");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
    lengthDescriptor.enumerable ||
    lengthDescriptor.value !== value.length
  ) {
    throw new WorkspaceError("unsupported_value", "Canonical array has an invalid length property");
  }
}

function canonicalizeValue(value: unknown, state: CanonicalizationState, depth: number): void {
  if (depth > state.limits.maxDepth) {
    throw new WorkspaceError("size_limit_exceeded", "Canonical data is nested too deeply");
  }
  if (value === null) {
    appendPrimitive(state, "null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      appendPrimitive(state, value ? "true" : "false");
      return;
    case "number":
      appendPrimitive(state, canonicalizeNumber(value));
      return;
    case "string":
      appendQuotedString(state, value);
      return;
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      throw new WorkspaceError(
        "unsupported_value",
        `Canonical data contains unsupported ${typeof value}`,
      );
    case "object":
      break;
    default:
      throw new WorkspaceError("unsupported_value", "Canonical data contains an unsupported value");
  }

  if (state.seen.has(value)) {
    throw new WorkspaceError("unsupported_value", "Canonical data contains a cycle");
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      assertArrayShape(value, state);
      appendPrimitive(state, "[");
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ) {
          throw new WorkspaceError("unsupported_value", "Canonical array contains a hole or accessor");
        }
        if (index > 0) {
          appendPrimitive(state, ",");
        }
        countEntry(state);
        canonicalizeValue(descriptor.value, state, depth + 1);
      }
      appendPrimitive(state, "]");
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkspaceError("unsupported_value", "Canonical data requires plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new WorkspaceError("unsupported_value", "Canonical object contains symbol keys");
    }
    const ownNames = Object.getOwnPropertyNames(value);
    if (ownNames.length > state.limits.maxEntries - state.entries) {
      throw new WorkspaceError("size_limit_exceeded", "Canonical data contains too many entries");
    }
    const keys = [...ownNames].sort(compareCodeUnits);
    appendPrimitive(state, "{");
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === undefined) {
        throw new WorkspaceError("unsupported_value", "Canonical object contains an invalid key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw new WorkspaceError("unsupported_value", "Canonical object contains an accessor or hidden property");
      }
      if (index > 0) {
        appendPrimitive(state, ",");
      }
      countEntry(state);
      appendQuotedString(state, key);
      appendPrimitive(state, ":");
      canonicalizeValue(descriptor.value, state, depth + 1);
    }
    appendPrimitive(state, "}");
  } finally {
    state.seen.delete(value);
  }
}

export function canonicalStringify(
  value: unknown,
  customLimits?: Partial<CanonicalizationLimits>,
): string {
  const limits = mergeLimits(customLimits);
  const state: CanonicalizationState = {
    limits,
    seen: new Set(),
    chunks: [],
    entries: 0,
    outputBytes: 0,
  };
  canonicalizeValue(value, state, 0);
  return state.chunks.join("");
}

export function sha256Bytes(data: Uint8Array): Sha256Digest {
  if (!(data instanceof Uint8Array)) {
    throw new WorkspaceError("invalid_argument", "SHA-256 input must be a Uint8Array");
  }
  return `sha256:${createHash("sha256").update(data).digest("hex")}` as Sha256Digest;
}

export function sha256Utf8(value: string): Sha256Digest {
  if (typeof value !== "string") {
    throw new WorkspaceError("invalid_argument", "SHA-256 UTF-8 input must be a string");
  }
  if (!isWellFormedString(value)) {
    throw new WorkspaceError("unsupported_value", "SHA-256 UTF-8 input contains malformed Unicode");
  }
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}` as Sha256Digest;
}

export async function sha256ByteStream(
  chunks: AsyncIterable<Uint8Array>,
): Promise<Sha256Digest> {
  const hash = createHash("sha256");
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) {
      throw new WorkspaceError("invalid_argument", "SHA-256 stream chunks must be Uint8Array values");
    }
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}` as Sha256Digest;
}

export function canonicalSha256(
  value: unknown,
  customLimits?: Partial<CanonicalizationLimits>,
): Sha256Digest {
  return sha256Utf8(canonicalStringify(value, customLimits));
}

export function canonicalizeSet(
  values: readonly unknown[],
  customLimits?: Partial<CanonicalizationLimits>,
): readonly unknown[] {
  if (!Array.isArray(values)) {
    throw new WorkspaceError("invalid_argument", "Set-like values must be an array");
  }
  canonicalStringify(values, customLimits);
  const entries: Array<{ readonly value: unknown; readonly serialized: string }> = [];
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(values, index)) {
      throw new WorkspaceError("unsupported_value", "Set-like array contains a hole");
    }
    const value = values[index];
    entries.push({
      value,
      serialized: canonicalStringify(value, customLimits),
    });
  }
  entries.sort((left, right) => compareCodeUnits(left.serialized, right.serialized));
  const result: unknown[] = [];
  let previous: string | undefined;
  for (const entry of entries) {
    if (entry.serialized !== previous) {
      result.push(entry.value);
      previous = entry.serialized;
    }
  }
  return Object.freeze(result);
}
