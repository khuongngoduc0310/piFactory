import { isIsoTimestamp } from "../domain/validation.js";
import { PersistenceError } from "./persistence-error.js";
import {
  DEFAULT_PERSISTENCE_LIMITS,
  PERSISTENCE_SCHEMA_VERSION,
  RUN_EVENT_TYPES,
  type JsonObject,
  type JsonValue,
  type NewRunEvent,
  type EventLogHeader,
  type PersistenceLimits,
  type RunEvent,
} from "./persistence-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventError(
  message: string,
  persisted: boolean,
  code: "invalid_event" | "corrupt_state" = "invalid_event",
): PersistenceError {
  return new PersistenceError(persisted ? "corrupt_state" : code, message);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  persisted: boolean,
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw eventError(`${label} contains unsupported fields`, persisted);
  }
}

function validateJsonValue(
  value: unknown,
  limits: PersistenceLimits,
  depth: number,
  seen: Set<object>,
): value is JsonValue {
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    return value.length <= limits.maxJsonStringLength;
  }
  if (typeof value !== "object" || depth > limits.maxJsonDepth) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return (
        value.length <= limits.maxJsonArrayLength &&
        value.every((entry) => validateJsonValue(entry, limits, depth + 1, seen))
      );
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      return false;
    }
    const objectValue = value as Record<string, unknown>;
    const keys = Object.keys(objectValue);
    return (
      keys.length <= limits.maxJsonEntries &&
      Object.getOwnPropertySymbols(value).length === 0 &&
      keys.every((key) => validateJsonValue(objectValue[key], limits, depth + 1, seen))
    );
  } finally {
    seen.delete(value);
  }
}

function cloneAndFreezeJsonObject(
  value: JsonObject,
  limits: PersistenceLimits,
): JsonObject {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > limits.maxEventPayloadBytes) {
    throw new PersistenceError("size_limit_exceeded", "Event payload exceeds its size limit");
  }
  const parsed = JSON.parse(serialized) as unknown;
  return freezeJsonObject(parsed, limits);
}

function freezeJsonValue(value: JsonValue, limits: PersistenceLimits): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeJsonValue(entry, limits)));
  }
  if (typeof value === "object" && value !== null) {
    const frozen: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(frozen, key, {
        configurable: false,
        enumerable: true,
        value: freezeJsonValue(entry, limits),
        writable: false,
      });
    }
    return Object.freeze(frozen);
  }
  return value;
}

function freezeJsonObject(value: unknown, limits: PersistenceLimits): JsonObject {
  if (!isRecord(value) || !validateJsonValue(value, limits, 0, new Set())) {
    throw new PersistenceError("corrupt_state", "Event payload is not valid JSON data");
  }
  return freezeJsonValue(value, limits) as JsonObject;
}

function assertJsonObject(
  value: unknown,
  limits: PersistenceLimits,
  persisted: boolean,
): asserts value is JsonObject {
  if (!isRecord(value) || !validateJsonValue(value, limits, 0, new Set())) {
    throw eventError("Event payload must be a bounded JSON object", persisted);
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw eventError("Event payload cannot be serialized", persisted);
  }
  if (Buffer.byteLength(serialized, "utf8") > limits.maxEventPayloadBytes) {
    throw new PersistenceError(
      "size_limit_exceeded",
      "Event payload exceeds its size limit",
    );
  }
}

function assertEventId(value: unknown, limits: PersistenceLimits, persisted: boolean): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > limits.maxJsonStringLength
  ) {
    throw eventError("Event id must be a bounded non-empty string", persisted);
  }
}

function assertNewEvent(
  value: unknown,
  runId: string,
  limits: PersistenceLimits,
  persisted: boolean,
): asserts value is NewRunEvent {
  if (!isRecord(value)) {
    throw eventError("Event must be an object", persisted);
  }
  assertAllowedKeys(value, ["id", "timestamp", "type", "payload"], "Event", persisted);
  assertEventId(value.id, limits, persisted);
  if (!isIsoTimestamp(value.timestamp)) {
    throw eventError("Event timestamp must be canonical UTC ISO-8601", persisted);
  }
  if (
    typeof value.type !== "string" ||
    !(RUN_EVENT_TYPES as readonly string[]).includes(value.type)
  ) {
    throw eventError("Event type is not supported", persisted);
  }
  assertJsonObject(value.payload, limits, persisted);
  if (value.runId !== undefined && value.runId !== runId) {
    throw new PersistenceError(
      "identity_mismatch",
      `Event belongs to a different run than ${runId}`,
    );
  }
}

function validateStoredEvent(
  value: unknown,
  runId: string,
  expectedSequence: number,
  limits: PersistenceLimits,
): RunEvent {
  if (!isRecord(value)) {
    throw eventError("Persisted event must be an object", true);
  }
  assertAllowedKeys(
    value,
    ["schemaVersion", "runId", "id", "sequence", "timestamp", "type", "payload"],
    "Persisted event",
    true,
  );
  if (value.schemaVersion !== PERSISTENCE_SCHEMA_VERSION) {
    throw new PersistenceError("unsupported_schema", "Persisted event schema is unsupported");
  }
  if (value.runId !== runId) {
    throw new PersistenceError("identity_mismatch", "Persisted event run ID does not match");
  }
  if (
    !Number.isSafeInteger(value.sequence) ||
    value.sequence !== expectedSequence ||
    value.sequence < 1
  ) {
    throw eventError("Persisted event sequence is not contiguous", true);
  }
  const eventWithoutEnvelope = {
    id: value.id,
    timestamp: value.timestamp,
    type: value.type,
    payload: value.payload,
  };
  assertNewEvent(eventWithoutEnvelope, runId, limits, true);
  return Object.freeze({
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    runId,
    id: eventWithoutEnvelope.id,
    sequence: expectedSequence,
    timestamp: eventWithoutEnvelope.timestamp,
    type: eventWithoutEnvelope.type,
    payload: cloneAndFreezeJsonObject(eventWithoutEnvelope.payload, limits),
  });
}

function assertEventHistory(events: readonly RunEvent[], runId: string, limits: PersistenceLimits): void {
  const ids = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) {
      throw new PersistenceError("corrupt_state", "Event history contains a missing entry");
    }
    if (ids.has(event.id)) {
      throw new PersistenceError("corrupt_state", `Duplicate event ID ${event.id}`);
    }
    ids.add(event.id);
    validateStoredEvent(event, runId, index + 1, limits);
  }
}

export function appendRunEvents(
  runId: string,
  existing: readonly RunEvent[],
  additions: readonly NewRunEvent[],
  limits: PersistenceLimits = DEFAULT_PERSISTENCE_LIMITS,
): readonly RunEvent[] {
  if (!Array.isArray(additions)) {
    throw new PersistenceError("invalid_event", "New events must be an array");
  }
  assertEventHistory(existing, runId, limits);
  const ids = new Set(existing.map(({ id }) => id));
  const result = existing.map((event) =>
    Object.freeze({
      ...event,
      payload: cloneAndFreezeJsonObject(event.payload, limits),
    }),
  );
  for (const addition of additions) {
    assertNewEvent(addition, runId, limits, false);
    if (ids.has(addition.id)) {
      throw new PersistenceError("invalid_event", `Duplicate event ID ${addition.id}`);
    }
    ids.add(addition.id);
    const sequence = result.length + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new PersistenceError("size_limit_exceeded", "Event sequence exceeds safe integer range");
    }
    result.push(
      Object.freeze({
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        runId,
        id: addition.id,
        sequence,
        timestamp: addition.timestamp,
        type: addition.type,
        payload: cloneAndFreezeJsonObject(addition.payload, limits),
      }),
    );
  }
  return Object.freeze(result);
}

export function encodeEventLog(
  events: readonly RunEvent[],
  runId: string,
  stateVersion: number,
  limits: PersistenceLimits = DEFAULT_PERSISTENCE_LIMITS,
): string {
  assertEventHistory(events, runId, limits);
  if (!Number.isSafeInteger(stateVersion) || stateVersion < 1) {
    throw new PersistenceError("invalid_argument", "Event log stateVersion is invalid");
  }
  const header: EventLogHeader = {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    kind: "event_log",
    runId,
    stateVersion,
  };
  const headerLine = JSON.stringify(header);
  if (headerLine === undefined || Buffer.byteLength(headerLine, "utf8") > limits.maxEventLineBytes) {
    throw new PersistenceError("size_limit_exceeded", "Event log header exceeds its size limit");
  }
  const lines = events.map((event) => {
    const line = JSON.stringify(event);
    if (line === undefined || Buffer.byteLength(line, "utf8") > limits.maxEventLineBytes) {
      throw new PersistenceError("size_limit_exceeded", "Event line exceeds its size limit");
    }
    return line;
  });
  const contents = `${[headerLine, ...lines].join("\n")}\n`;
  if (Buffer.byteLength(contents, "utf8") > limits.maxEventLogBytes) {
    throw new PersistenceError("size_limit_exceeded", "Event log exceeds its size limit");
  }
  return contents;
}

export function decodeEventLog(
  contents: string,
  runId: string,
  stateVersion: number,
  limits: PersistenceLimits = DEFAULT_PERSISTENCE_LIMITS,
): readonly RunEvent[] {
  if (Buffer.byteLength(contents, "utf8") > limits.maxEventLogBytes) {
    throw new PersistenceError("size_limit_exceeded", "Event log exceeds its size limit");
  }
  if (contents.length === 0) {
    return Object.freeze([]);
  }
  if (!contents.endsWith("\n")) {
    throw new PersistenceError("corrupt_state", "Event log must end with a complete line");
  }
  const lines = contents.slice(0, -1).split("\n");
  const headerLine = lines.shift();
  if (headerLine === undefined || headerLine.length === 0) {
    throw new PersistenceError("corrupt_state", "Event log header is missing");
  }
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(headerLine) as unknown;
  } catch (error) {
    throw new PersistenceError("corrupt_state", "Event log header contains malformed JSON", {
      cause: error,
    });
  }
  if (!isRecord(headerValue)) {
    throw new PersistenceError("corrupt_state", "Event log header must be an object");
  }
  assertAllowedKeys(
    headerValue,
    ["schemaVersion", "kind", "runId", "stateVersion"],
    "Event log header",
    true,
  );
  if (headerValue.schemaVersion !== PERSISTENCE_SCHEMA_VERSION) {
    throw new PersistenceError("unsupported_schema", "Event log schema is unsupported");
  }
  if (headerValue.kind !== "event_log") {
    throw new PersistenceError("corrupt_state", "Event log header kind is invalid");
  }
  if (headerValue.runId !== runId) {
    throw new PersistenceError("identity_mismatch", "Event log header run ID does not match");
  }
  if (headerValue.stateVersion !== stateVersion) {
    throw new PersistenceError("identity_mismatch", "Event log state version does not match");
  }
  const events: RunEvent[] = [];
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.length === 0 || Buffer.byteLength(line, "utf8") > limits.maxEventLineBytes) {
      throw new PersistenceError("corrupt_state", "Event log contains an invalid line");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new PersistenceError("corrupt_state", "Event log contains malformed JSON", {
        cause: error,
      });
    }
    const event = validateStoredEvent(parsed, runId, events.length + 1, limits);
    if (ids.has(event.id)) {
      throw new PersistenceError("corrupt_state", `Duplicate event ID ${event.id}`);
    }
    ids.add(event.id);
    events.push(event);
  }
  return Object.freeze(events);
}
