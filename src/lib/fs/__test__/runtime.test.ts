import { describe, it, expect, afterEach } from "vitest";
import { isTauri } from "../runtime";

describe("isTauri", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("returns false in plain browser/Node", () => {
    expect(isTauri()).toBe(false);
  });

  it("returns true when __TAURI_INTERNALS__ is present", () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(isTauri()).toBe(true);
  });
});
