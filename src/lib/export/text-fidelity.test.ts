// AQU-2383: the encoding envelope an export must put back around rebuilt text.
import { describe, it, expect } from "vitest"
import {
  detectTextFidelity,
  applyTextFidelity,
  NORMALIZED_TEXT_FIDELITY,
  type TextFidelity,
} from "./text-fidelity"

const BOM = "﻿"

describe("detectTextFidelity", () => {
  const cases: ReadonlyArray<readonly [string, string, TextFidelity]> = [
    ["LF file", "one\ntwo\n", { bom: false, eol: "\n" }],
    ["CRLF file", "one\r\ntwo\r\n", { bom: false, eol: "\r\n" }],
    ["BOM + LF", `${BOM}one\ntwo\n`, { bom: true, eol: "\n" }],
    ["BOM + CRLF", `${BOM}one\r\ntwo\r\n`, { bom: true, eol: "\r\n" }],
    ["no line breaks at all", "one line, no terminator", { bom: false, eol: "\n" }],
    ["empty file", "", { bom: false, eol: "\n" }],
    // Majority, not first sighting: three CRLF against one LF is a CRLF file.
    ["mixed, CRLF dominant", "a\r\nb\r\nc\r\nd\ne", { bom: false, eol: "\r\n" }],
    ["mixed, LF dominant", "a\nb\nc\nd\r\ne", { bom: false, eol: "\n" }],
    // A tie resolves to LF so a file with nothing to preserve is left alone.
    ["mixed, tied", "a\r\nb\nc", { bom: false, eol: "\n" }],
  ]
  for (const [name, source, expected] of cases) {
    it(name, () => {
      expect(detectTextFidelity(source)).toEqual(expected)
    })
  }
})

describe("applyTextFidelity", () => {
  it("leaves an LF body alone when the source was LF", () => {
    expect(applyTextFidelity("one\ntwo\n", { bom: false, eol: "\n" })).toBe("one\ntwo\n")
  })

  it("rewrites an LF body to CRLF when the source was CRLF", () => {
    expect(applyTextFidelity("one\ntwo\n", { bom: false, eol: "\r\n" })).toBe("one\r\ntwo\r\n")
  })

  it("restores the byte-order mark the parser stripped", () => {
    expect(applyTextFidelity("one\n", { bom: true, eol: "\n" })).toBe(`${BOM}one\n`)
  })

  it("does not double a mark the body already carries", () => {
    expect(applyTextFidelity(`${BOM}one\n`, { bom: true, eol: "\n" })).toBe(`${BOM}one\n`)
  })

  it("drops a mark the source did not have", () => {
    expect(applyTextFidelity(`${BOM}one\n`, { bom: false, eol: "\n" })).toBe("one\n")
  })

  it("does not turn a CRLF already in the body into CR CR LF", () => {
    expect(applyTextFidelity("one\r\ntwo\n", { bom: false, eol: "\r\n" })).toBe("one\r\ntwo\r\n")
  })

  it("keeps an empty export empty rather than emitting a lone mark", () => {
    expect(applyTextFidelity("", { bom: true, eol: "\r\n" })).toBe("")
  })

  it("is the identity for a parser-normalized envelope", () => {
    expect(applyTextFidelity("one\ntwo\n", NORMALIZED_TEXT_FIDELITY)).toBe("one\ntwo\n")
  })
})

describe("detect → apply round trip", () => {
  // The property that matters: for a source the parser can reproduce verbatim
  // as its own body, re-applying the detected envelope returns the source.
  const sources = [
    "one\ntwo\n",
    "one\r\ntwo\r\n",
    `${BOM}one\ntwo\n`,
    `${BOM}one\r\ntwo\r\n`,
    "single line",
  ]
  for (const source of sources) {
    it(`restores ${JSON.stringify(source)}`, () => {
      const fidelity = detectTextFidelity(source)
      const normalized = source.replace(/^﻿/, "").replace(/\r\n/g, "\n")
      expect(applyTextFidelity(normalized, fidelity)).toBe(source)
    })
  }
})
