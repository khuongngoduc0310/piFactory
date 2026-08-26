import { describe, expect, it } from "vitest";

import {
  canonicalSha256,
  canonicalStringify,
  canonicalizeSet,
  sha256ByteStream,
  sha256Bytes,
  sha256Utf8,
} from "../../src/workspace/index.js";

describe("workspace digests", () => {
  it("produces prefixed SHA-256 digests for bytes, UTF-8, and streams", async () => {
    expect(sha256Bytes(new Uint8Array())).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Utf8("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      await sha256ByteStream(
        (async function* (): AsyncGenerator<Uint8Array> {
          yield new Uint8Array([0, 1]);
          yield new Uint8Array([2, 255]);
        })(),
      ),
    ).toBe(sha256Bytes(new Uint8Array([0, 1, 2, 255])));
  });

  it("canonicalizes object keys independently of insertion order", () => {
    const first = { b: { z: false, a: null }, a: 1 };
    const second = { a: 1, b: { a: null, z: false } };

    expect(canonicalStringify(first)).toBe('{"a":1,"b":{"a":null,"z":false}}');
    expect(canonicalSha256(first)).toBe(canonicalSha256(second));
  });

  it("preserves ordered arrays and supports explicitly set-like arrays", () => {
    expect(canonicalSha256(["a", "b"])).not.toBe(canonicalSha256(["b", "a"]));
    const set = canonicalizeSet([{ b: 2, a: 1 }, { a: 1, b: 2 }, "b", "a"]);

    expect(set).toEqual(["a", "b", { b: 2, a: 1 }]);
    expect(Object.isFrozen(set)).toBe(true);
  });

  it("keeps absent properties, null, false, zero, and empty strings distinct", () => {
    expect(canonicalSha256({})).not.toBe(canonicalSha256({ value: null }));
    expect(canonicalSha256({ value: null })).not.toBe(canonicalSha256({ value: false }));
    expect(canonicalSha256({ value: false })).not.toBe(canonicalSha256({ value: 0 }));
    expect(canonicalSha256({ value: 0 })).not.toBe(canonicalSha256({ value: "" }));
    expect(canonicalStringify(-0)).toBe("0");
  });

  it("rejects unsupported, ambiguous, and cyclic values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = [] as unknown[];
    sparse.length = 1;
    const accessor = {};
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
    const hidden = {};
    Object.defineProperty(hidden, "value", { enumerable: false, value: 1 });

    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      () => undefined,
      Symbol("value"),
      new Date(0),
      new Map(),
      cyclic,
      sparse,
      accessor,
      hidden,
    ]) {
      expect(() => canonicalStringify(value)).toThrow();
    }
  });

  it("treats a JSON __proto__ key as data", () => {
    const value = JSON.parse('{"__proto__":{"safe":true}}') as unknown;

    expect(canonicalStringify(value)).toBe('{"__proto__":{"safe":true}}');
    expect((Object.prototype as Record<string, unknown>).safe).toBeUndefined();
  });

  it("rejects malformed Unicode instead of allowing replacement characters", () => {
    expect(() => canonicalStringify("\ud800")).toThrowError(
      expect.objectContaining({ code: "unsupported_value" }),
    );
    expect(() => sha256Utf8("\udfff")).toThrowError(
      expect.objectContaining({ code: "unsupported_value" }),
    );
  });

  it("enforces the canonical output limit before producing oversized output", () => {
    expect(() => canonicalStringify({ value: "12345" }, { maxOutputBytes: 16 })).toThrowError(
      expect.objectContaining({ code: "size_limit_exceeded" }),
    );
    expect(canonicalStringify({ value: "12345" }, { maxOutputBytes: 17 })).toBe('{"value":"12345"}');
    expect(() => canonicalStringify("\n\n", { maxOutputBytes: 5 })).toThrowError(
      expect.objectContaining({ code: "size_limit_exceeded" }),
    );
    expect(canonicalStringify("\n\n", { maxOutputBytes: 6 })).toBe('"\\n\\n"');
  });

  it("rejects non-standard array shapes but accepts frozen arrays", () => {
    class CustomArray extends Array<number> {}
    const custom = new CustomArray(1, 2);
    const hidden = [1];
    Object.defineProperty(hidden, "0", { enumerable: false, value: 1 });
    const accessor = [1];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => 1 });

    expect(() => canonicalStringify(custom)).toThrowError(
      expect.objectContaining({ code: "unsupported_value" }),
    );
    expect(() => canonicalStringify(hidden)).toThrowError(
      expect.objectContaining({ code: "unsupported_value" }),
    );
    expect(() => canonicalStringify(accessor)).toThrowError(
      expect.objectContaining({ code: "unsupported_value" }),
    );
    expect(canonicalStringify(Object.freeze([1, 2]))).toBe("[1,2]");
  });

  it("enforces nested canonicalization depth at leaf values", () => {
    expect(canonicalStringify({ value: 1 }, { maxDepth: 1 })).toBe('{"value":1}');
    expect(() => canonicalStringify({ child: { value: 1 } }, { maxDepth: 1 })).toThrowError(
      expect.objectContaining({ code: "size_limit_exceeded" }),
    );
    expect(() => canonicalStringify({}, { maxDepth: 1_025 })).toThrowError(
      expect.objectContaining({ code: "invalid_argument" }),
    );
  });
});
