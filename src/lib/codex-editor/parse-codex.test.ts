import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexNotebook } from "./parse-codex";

const FIXTURE_DIR = join(__dirname, "../../../tests/fixtures/codex-editor");

describe("parseCodexNotebook", () => {
  it("parses a .codex file into cells and metadata", () => {
    const raw = readFileSync(join(FIXTURE_DIR, "sample.codex"), "utf8");
    const parsed = parseCodexNotebook(raw);
    expect(parsed.cells).toHaveLength(2);
    expect(parsed.cells[0].metadata.id).toBe("GEN 1:1");
    expect(parsed.cells[0].metadata.edits?.[0].author).toBe("alice");
    expect(parsed.metadata.videoUrl).toBe("https://example.com/gen.mp4");
  });

  it("accepts a .source file (same schema)", () => {
    const raw = readFileSync(join(FIXTURE_DIR, "sample.source"), "utf8");
    const parsed = parseCodexNotebook(raw);
    expect(parsed.cells[0].value).toContain("In the beginning");
  });

  it("throws on malformed JSON", () => {
    expect(() => parseCodexNotebook("{oops")).toThrow(/JSON/i);
  });

  it("throws when cells missing", () => {
    expect(() => parseCodexNotebook('{"metadata":{}}')).toThrow(/cells/);
  });
});
