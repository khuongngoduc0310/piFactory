import { describe, expect, it } from "vitest";

import {
  isPathEqualOrWithin,
  parseRepositoryPath,
  validateRepositoryPath,
} from "../../src/workspace/index.js";

describe("repository path validation", () => {
  it("accepts canonical repository-relative paths without rewriting them", () => {
    expect(parseRepositoryPath("src/auth/index.ts")).toBe("src/auth/index.ts");
    expect(parseRepositoryPath("docs/space name/README.md")).toBe("docs/space name/README.md");
    expect(parseRepositoryPath("%2e%2e/not-a-traversal")).toBe("%2e%2e/not-a-traversal");
  });

  it("rejects absolute, traversal, separator, URL, and Windows-specific forms", () => {
    const invalid = [
      "/etc/passwd",
      "C:/outside",
      "C:outside",
      "\\\\server\\share",
      "file://outside",
      "a/../b",
      "a/./b",
      "a//b",
      "a/",
      "a\\b",
      "a:b",
      "a?b",
      "CON.txt",
      "folder/name.",
    ];

    for (const value of invalid) {
      expect(validateRepositoryPath(value).length, value).toBeGreaterThan(0);
      expect(() => parseRepositoryPath(value), value).toThrowError(
        expect.objectContaining({ code: "invalid_path" }),
      );
    }
  });

  it("rejects controls, malformed Unicode, and oversized components", () => {
    expect(validateRepositoryPath("src/\u0000file")).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "control_character" })]),
    );
    expect(validateRepositoryPath("\ud800")).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "malformed_unicode" })]),
    );
    expect(
      validateRepositoryPath("long", { limits: { maxPathBytes: 3 } }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "too_long" })]));
  });

  it("matches exact paths and descendants without prefix confusion", () => {
    const scope = parseRepositoryPath("src/auth");

    expect(isPathEqualOrWithin(parseRepositoryPath("src/auth"), scope)).toBe(true);
    expect(isPathEqualOrWithin(parseRepositoryPath("src/auth/login.ts"), scope)).toBe(true);
    expect(isPathEqualOrWithin(parseRepositoryPath("src/authentication.ts"), scope)).toBe(false);
    expect(
      isPathEqualOrWithin(parseRepositoryPath("SRC/AUTH/login.ts"), scope, "insensitive"),
    ).toBe(true);
    expect(
      isPathEqualOrWithin(parseRepositoryPath("SRC/AUTH/login.ts"), scope, "sensitive"),
    ).toBe(false);
  });
});
