// Acceptance tests for the QA rows of PARITY_MATRIX.yaml.
import { describe, it, expect } from "vitest"
import {
  checkTags,
  checkWhitespace,
  checkSymbols,
  checkNumbers,
  findConflicts,
  runSegmentQa,
} from "@/lib/qa/checks"

describe("segment QA", () => {
  it("[qa.tags] flags missing source tags in target as blocking", () => {
    const issues = checkTags('Press <g id="1">Save</g> then <x id="2"/>.', "Appuyez sur Enregistrer.")
    expect(issues.some((i) => i.severity === "blocking" && i.message.includes("missing"))).toBe(true)
  })

  it("[qa.tags] flags unclosed paired tag in target as blocking (file-breaking)", () => {
    const issues = checkTags("<b>Bold</b> text", "<b>Gras text")
    expect(issues.some((i) => i.severity === "blocking" && i.message.includes("unclosed"))).toBe(true)
  })

  it("[qa.tags] flags extra target tags as error and order changes as warning only", () => {
    expect(
      checkTags("Plain source", "Cible <b>en gras</b>").some((i) => i.severity === "error"),
    ).toBe(true)
    const order = checkTags('A <x id="1"/> b <x id="2"/>', 'A <x id="2"/> b <x id="1"/>')
    expect(order).toHaveLength(1)
    expect(order[0].severity).toBe("warning")
    expect(order[0].message).toContain("order")
  })

  it("[qa.tags] placeholder syntaxes ({0}, {{var}}, %s, %1$s) are checked like tags", () => {
    expect(checkTags("Hello {0}, you have {{count}} items (%1$s)", "Bonjour, vous avez des articles")).not.toHaveLength(0)
    expect(checkTags("Hello {0}", "Bonjour {0}")).toHaveLength(0)
  })

  it("[qa.tags] clean translations produce no issues; empty targets are skipped", () => {
    expect(checkTags('Press <g id="1">Save</g>', 'Appuyez <g id="1">Enregistrer</g>')).toHaveLength(0)
    expect(checkTags("<b>Anything</b>", "")).toHaveLength(0)
  })

  it("[qa.whitespace] flags newline/tab count and leading/trailing whitespace mismatches (non-blocking)", () => {
    const issues = checkWhitespace("Line1\nLine2\tTabbed ", "Ligne1 Ligne2 Tabulé")
    const messages = issues.map((i) => i.message)
    expect(messages.some((m) => m.includes("newline"))).toBe(true)
    expect(messages.some((m) => m.includes("tab"))).toBe(true)
    expect(messages.some((m) => m.includes("trailing"))).toBe(true)
    expect(issues.every((i) => i.severity === "warning")).toBe(true)
    expect(checkWhitespace("Same\nshape\t x ", "Même\nforme\t y ")).toHaveLength(0)
  })

  it("[qa.symbols] flags count mismatches of $ # @ £ % = *", () => {
    const issues = checkSymbols("Price: $100 (#1, 5% off)", "Prix : 100 (n°1, 5 pour cent)")
    const flagged = issues.map((i) => i.message[1]) // the symbol inside quotes
    expect(flagged).toContain("$")
    expect(flagged).toContain("#")
    expect(flagged).toContain("%")
    expect(checkSymbols("100% of $5", "100% de $5")).toHaveLength(0)
  })

  it("[qa.numbers] flags source numbers missing from target, tolerant of 1,000/1000/1.000 formats", () => {
    expect(checkNumbers("Take 2 tablets within 24 hours", "Prendre des comprimés")).toHaveLength(2)
    expect(checkNumbers("1,000 users", "1.000 utilisateurs")).toHaveLength(0)
    expect(checkNumbers("1 000 users", "1000 utilisateurs")).toHaveLength(0)
    expect(checkNumbers("version 2.5", "version 2.5")).toHaveLength(0)
  })

  it("[qa.conflicts] detects identical sources with differing targets project-wide", () => {
    const conflicts = findConflicts([
      { id: "a", source: "Save", target: "Enregistrer" },
      { id: "b", source: "save", target: "Sauvegarder" },
      { id: "c", source: "Save", target: "Enregistrer" },
      { id: "d", source: "Cancel", target: "Annuler" },
      { id: "e", source: "Empty", target: "" },
    ])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].targets.sort()).toEqual(["Enregistrer", "Sauvegarder"])
    expect(conflicts[0].segmentIds.sort()).toEqual(["a", "b", "c"])
  })

  it("[qa.tags] runSegmentQa aggregates all checks for a segment", () => {
    const issues = runSegmentQa("<b>2 items</b> for $5", "Deux articles")
    const checks = new Set(issues.map((i) => i.check))
    expect(checks.has("tags")).toBe(true)
    expect(checks.has("symbols")).toBe(true)
    expect(checks.has("numbers")).toBe(true)
  })
})
