import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexProjectMetadata } from "./parse-metadata";

const FIXTURE_DIR = join(__dirname, "../../../tests/fixtures/codex-editor");

describe("parseCodexProjectMetadata", () => {
  it("parses project metadata", () => {
    const raw = readFileSync(join(FIXTURE_DIR, "metadata.json"), "utf8");
    const meta = parseCodexProjectMetadata(raw);
    expect(meta.projectName).toBe("Sample Genesis");
    expect(meta.sourceLanguage?.tag).toBe("en");
    expect(meta.targetLanguage?.tag).toBe("de");
  });

  it("tolerates unknown fields", () => {
    const meta = parseCodexProjectMetadata('{"projectName":"X","weird":42}');
    expect(meta.projectName).toBe("X");
  });

  it("throws on non-object", () => {
    expect(() => parseCodexProjectMetadata("[]")).toThrow();
  });
});
