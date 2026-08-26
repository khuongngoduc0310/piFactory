import { describe, expect, it } from "vitest";

import {
  appendRunEvents,
  decodeEventLog,
  encodeEventLog,
} from "../../src/persistence/event-log.js";
import { PersistenceError } from "../../src/persistence/persistence-error.js";
import type { NewRunEvent } from "../../src/persistence/persistence-types.js";

const T0 = "2026-08-25T10:00:00.000Z";
const T1 = "2026-08-25T10:01:00.000Z";

const first: NewRunEvent = {
  id: "one",
  timestamp: T0,
  type: "factory_run_created",
  payload: { nested: { value: true } },
};

describe("event log", () => {
  it("assigns sequences and preserves the previous event prefix", () => {
    const initial = appendRunEvents("run-1", [], [first]);
    const next = appendRunEvents("run-1", initial, [
      { id: "two", timestamp: T1, type: "node_started", payload: { nodeId: "build" } },
    ]);

    expect(next.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(next[0]).toEqual(initial[0]);
    expect(decodeEventLog(encodeEventLog(next, "run-1", 1), "run-1", 1)).toEqual(next);
  });

  it("rejects duplicate IDs, malformed lines, gaps, and unsupported schemas", () => {
    const initial = appendRunEvents("run-1", [], [first]);
    const header = encodeEventLog(initial, "run-1", 1).split("\n")[0];

    expect(() => appendRunEvents("run-1", initial, [first])).toThrowError(
      expect.objectContaining({ code: "invalid_event" }),
    );
    expect(() => decodeEventLog(`${header}\n{malformed}\n`, "run-1", 1)).toThrowError(
      expect.objectContaining({ code: "corrupt_state" }),
    );
    expect(() => decodeEventLog(`${header}\n${JSON.stringify(initial[0])}`, "run-1", 1)).toThrowError(
      expect.objectContaining({ code: "corrupt_state" }),
    );
    expect(() =>
      decodeEventLog(
        `${header}\n${JSON.stringify({ ...initial[0], sequence: 2 })}\n`,
        "run-1",
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: "corrupt_state" }));
    expect(() =>
      decodeEventLog(
        `${header}\n${JSON.stringify({ ...initial[0], schemaVersion: 99 })}\n`,
        "run-1",
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: "unsupported_schema" }));
  });

  it("rejects invalid payloads and keeps input values independent", () => {
    const payload = { value: "before" };
    const events = appendRunEvents("run-1", [], [
      { ...first, payload },
    ]);
    payload.value = "after";

    expect(events[0]?.payload).toEqual({ value: "before" });
    expect(Object.isFrozen(events[0]?.payload)).toBe(true);
    expect(() =>
      appendRunEvents("run-1", [], [
        {
          id: "bad",
          timestamp: T0,
          type: "factory_run_created",
          payload: { value: Number.NaN },
        },
      ]),
    ).toThrowError(PersistenceError);
  });

  it("preserves a JSON property named __proto__ without changing prototypes", () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"value":1}') as {
      readonly [key: string]: unknown;
    };
    const events = appendRunEvents("run-1", [], [
      { ...first, id: "proto", payload: payload as NewRunEvent["payload"] },
    ]);
    const restoredPayload = events[0]?.payload as Record<string, unknown> | undefined;

    expect(Object.prototype.hasOwnProperty.call(restoredPayload, "__proto__")).toBe(true);
    expect(restoredPayload?.["__proto__"]).toEqual({ polluted: true });
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });
});
