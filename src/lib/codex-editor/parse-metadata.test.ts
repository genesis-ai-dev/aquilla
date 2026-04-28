import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractProjectLanguages, parseCodexProjectMetadata } from "./parse-metadata";

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

describe("extractProjectLanguages", () => {
  it("reads tags from the modern flat shape", () => {
    const meta = parseCodexProjectMetadata(
      JSON.stringify({
        sourceLanguage: { tag: "en", refName: "English" },
        targetLanguage: { tag: "fr", refName: "French" },
      }),
    );
    expect(extractProjectLanguages(meta)).toEqual({ sourceTag: "en", targetTag: "fr" });
  });

  it("falls back to the legacy languages array when flat fields are missing", () => {
    const meta = parseCodexProjectMetadata(
      JSON.stringify({
        languages: [
          { tag: "es", refName: "Spanish", projectStatus: "source" },
          { tag: "qu", refName: "Quechua", projectStatus: "target" },
        ],
      }),
    );
    expect(extractProjectLanguages(meta)).toEqual({ sourceTag: "es", targetTag: "qu" });
  });

  it("prefers the flat shape when both are present", () => {
    const meta = parseCodexProjectMetadata(
      JSON.stringify({
        sourceLanguage: { tag: "en" },
        targetLanguage: { tag: "fr" },
        languages: [
          { tag: "stale-source", projectStatus: "source" },
          { tag: "stale-target", projectStatus: "target" },
        ],
      }),
    );
    expect(extractProjectLanguages(meta)).toEqual({ sourceTag: "en", targetTag: "fr" });
  });

  it("returns undefined for missing sides instead of guessing", () => {
    const meta = parseCodexProjectMetadata(
      JSON.stringify({
        languages: [{ tag: "es", projectStatus: "source" }],
      }),
    );
    expect(extractProjectLanguages(meta)).toEqual({ sourceTag: "es", targetTag: undefined });
  });
});
