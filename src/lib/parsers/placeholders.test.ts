import { describe, it, expect } from "vitest"
import {
  classifyPlaceholder,
  comparePlaceholders,
  detectPlaceholders,
  placeholderMetadata,
  placeholderPromptInstruction,
  placeholdersIntact,
} from "./placeholders"
import { extractJsonStrings, exportJson } from "./json-i18n"
import { extractPoStrings, exportPo } from "./po"
import { extractPropertiesStrings, exportProperties } from "./properties"
import { checkPlaceholders, runSegmentQa } from "@/lib/qa/checks"
import { buildPrompt } from "@/lib/completion/prompt-build"
import type { ExportCellFields } from "./core-types"

/** Export inputs built from the extracted strings with no edits at all. */
const untouched = (
  strings: readonly { original: string; context: string; group: string }[],
): ExportCellFields[] =>
  strings.map((s) => ({ original: s.original, translated: "", context: s.context, group: s.group }))

// ─── AQU-2386: detection + classification ────────────────────────────────────

describe("placeholder detection", () => {
  it("classifies every supported family as named or ordered", () => {
    const cases: [string, "named" | "ordered", string][] = [
      // printf
      ["%s", "ordered", ""],
      ["%d", "ordered", ""],
      ["%1$s", "named", "1"],
      // Apple
      ["%@", "ordered", ""],
      ["%1$@", "named", "1"],
      // ICU / i18next
      ["{name}", "named", "name"],
      ["{{count}}", "named", "count"],
      ["{0}", "named", "0"],
      ["{}", "ordered", ""],
      // python
      ["%(name)s", "named", "name"],
      // Laravel
      [":name", "named", "name"],
      // shell / JS template
      ["${name}", "named", "name"],
    ]
    for (const [raw, kind, name] of cases) {
      expect(classifyPlaceholder(raw), raw).toEqual({ kind, name })
      expect(detectPlaceholders(`before ${raw} after`).map((t) => t.raw), raw).toEqual([raw])
    }
  })

  it("reads ${name} as one token, not the {name} inside it", () => {
    expect(detectPlaceholders("Hi ${user}!").map((t) => t.raw)).toEqual(["${user}"])
  })

  it("does not mistake prose, times or URL schemes for a :name placeholder", () => {
    expect(detectPlaceholders("Open https://example.com at 10:30 — ratio a:b")).toEqual([])
    expect(detectPlaceholders("Note: see the manual")).toEqual([])
  })

  it("returns metadata only for strings that carry placeholders", () => {
    expect(placeholderMetadata("Plain sentence.")).toBeUndefined()
    expect(placeholderMetadata("Hello {name}, you have %d new")).toEqual([
      { raw: "{name}", kind: "named", name: "name" },
      { raw: "%d", kind: "ordered", name: "" },
    ])
  })
})

// ─── AQU-2386: named may move, unnamed may not ───────────────────────────────

describe("placeholder comparison", () => {
  it("accepts a reorder of named placeholders", () => {
    const diff = comparePlaceholders("{greeting}, {name}!", "{name}, {greeting} !")
    expect(diff.reordered).toBe(false)
    expect(placeholdersIntact(diff)).toBe(true)
  })

  it("flags a reorder of unnamed placeholders, whose order is their meaning", () => {
    const diff = comparePlaceholders("%s has %d items", "%d articles pour %s")
    expect(diff.reordered).toBe(true)
    expect(diff.dropped).toEqual([])
    expect(diff.added).toEqual([])
  })

  it("reports dropped, added and duplicated placeholders", () => {
    expect(comparePlaceholders("Hello {name} (%s)", "Bonjour").dropped).toEqual(["{name}", "%s"])
    expect(comparePlaceholders("Hello", "Bonjour {name}").added).toEqual(["{name}"])
    expect(comparePlaceholders("Hello {name}", "Bonjour {name} {name}").duplicated).toEqual(["{name}"])
  })

  it("treats a translated placeholder name as dropped-and-added, never as intact", () => {
    const diff = comparePlaceholders("Hello {name}", "Bonjour {nom}")
    expect(diff.dropped).toEqual(["{name}"])
    expect(diff.added).toEqual(["{nom}"])
  })
})

// ─── AQU-2386: QA ────────────────────────────────────────────────────────────

describe("placeholder QA check", () => {
  it("blocks a dropped placeholder and errors on an invented or duplicated one", () => {
    expect(
      checkPlaceholders("Save %s", "Enregistrer").some(
        (i) => i.severity === "blocking" && i.message.includes("missing"),
      ),
    ).toBe(true)
    expect(
      checkPlaceholders("Save", "Enregistrer %s").some(
        (i) => i.severity === "error" && i.message.includes("not in source"),
      ),
    ).toBe(true)
    expect(
      checkPlaceholders("Save {name}", "Enregistrer {name} {name}").some((i) =>
        i.message.includes("duplicates"),
      ),
    ).toBe(true)
  })

  it("warns about an unnamed reorder only, never a named one", () => {
    const unnamed = checkPlaceholders("%s has %d items", "%d articles pour %s")
    expect(unnamed).toHaveLength(1)
    expect(unnamed[0].severity).toBe("warning")
    expect(unnamed[0].message).toContain("order")
    expect(checkPlaceholders("{greeting}, {name}!", "{name}, {greeting} !")).toHaveLength(0)
    expect(checkPlaceholders("Items: %1$s of %2$s", "%2$s 中 %1$s")).toHaveLength(0)
  })

  it("skips empty targets and joins the segment QA run", () => {
    expect(checkPlaceholders("Hello {name}", "")).toHaveLength(0)
    expect(runSegmentQa("Hello {name}", "Bonjour").map((i) => i.check)).toContain("placeholders")
  })
})

// ─── AQU-2386: import metadata ───────────────────────────────────────────────

describe("software-string imports record placeholders", () => {
  it("records them for JSON i18n leaves", () => {
    const strings = extractJsonStrings('{"greeting":"Hi {name}","plain":"No tokens"}')
    expect(strings[0].metadata?.placeholders).toEqual([{ raw: "{name}", kind: "named", name: "name" }])
    expect(strings[1].metadata).toBeUndefined()
  })

  it("records them per PO form, including the plural msgid's own tokens", () => {
    const po = [
      'msgid "One file"',
      'msgid_plural "%d files"',
      'msgstr[0] ""',
      'msgstr[1] ""',
      "",
      'msgid "Welcome"',
      'msgstr ""',
    ].join("\n")
    const strings = extractPoStrings(po)
    expect(strings[0].metadata?.placeholders).toBeUndefined()
    expect(strings[1].metadata?.placeholders).toEqual([{ raw: "%d", kind: "ordered", name: "" }])
    expect(strings[2].metadata?.placeholders).toBeUndefined()
    // The existing `po` provenance bucket is preserved alongside.
    expect(strings[1].metadata?.po).toBeDefined()
  })

  it("records them for .properties values", () => {
    const strings = extractPropertiesStrings("welcome=Hello {0}\nplain=Nothing here\n")
    expect(strings[0].metadata?.placeholders).toEqual([{ raw: "{0}", kind: "named", name: "0" }])
    expect(strings[1].metadata).toBeUndefined()
  })
})

// ─── AQU-2386: export writes placeholders back unchanged ─────────────────────

describe("round trips keep placeholders byte-identical", () => {
  it("JSON i18n", async () => {
    const original = '{\n  "greeting": "Hi {name}, you have %d new",\n  "bye": "Bye ${user}"\n}\n'
    const strings = extractJsonStrings(original)
    const out = await exportJson(original, untouched(strings), { keyed: true }).text()
    expect(out).toBe(original)
  })

  it("PO", async () => {
    const original = [
      'msgid "Hi %s, you have %1$d new"',
      'msgstr "Hi %s, you have %1$d new"',
      "",
      'msgid "Bye :name"',
      'msgstr "Bye :name"',
      "",
    ].join("\n")
    const strings = extractPoStrings(original)
    const out = await exportPo(original, untouched(strings)).text()
    expect(out).toBe(original)
  })

  it(".properties", async () => {
    const original = "welcome=Hello {0} and %(name)s\nbye=Bye %@\n"
    const strings = extractPropertiesStrings(original)
    const out = await exportProperties(original, untouched(strings)).text()
    expect(out).toBe(original)
  })
})

// ─── AQU-2386: the drafting prompt ───────────────────────────────────────────

describe("drafting prompt", () => {
  it("names the source's placeholders and the rule for moving them", () => {
    const rule = placeholderPromptInstruction("Hello {name}, you have %d new")
    expect(rule).toContain("{name}")
    expect(rule).toContain("%d")
    expect(rule).toContain("exactly as written")
  })

  it("says nothing for prose, so a prose project's prompt is unchanged", () => {
    expect(placeholderPromptInstruction("In the beginning was the Word.")).toBe("")
    const [system] = buildPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      sourceText: "In the beginning was the Word.",
      examples: [],
    })
    expect(system.content).not.toContain("Placeholders (strictly enforced)")
  })

  it("carries the rule in the system message when the source has placeholders", () => {
    const [system] = buildPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      sourceText: "Hello {name}, you have %d new",
      examples: [],
    })
    expect(system.content).toContain("Placeholders (strictly enforced)")
    expect(system.content).toContain("{name}")
    // The role text's own language placeholders are still substituted.
    expect(system.content).not.toContain("{targetLanguage}")
  })
})
