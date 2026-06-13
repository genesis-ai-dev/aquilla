// Unit tests for the execute.aquifer argument guard.
//
// WHY: the guard is the contract boundary between the model's free-form
// {op,...} and the typed op the handler runs. These freeze which shapes are
// accepted and which produce a self-correcting error the model sees.

import { describe, it, expect } from "vitest"
import { parseAquiferOp } from "../lib/agent/aquifer-guard"

describe("parseAquiferOp", () => {
  it("rejects a missing/blank op", () => {
    expect(parseAquiferOp({}).ok).toBe(false)
    expect(parseAquiferOp({ op: "  " }).ok).toBe(false)
    expect(parseAquiferOp("nope").ok).toBe(false)
  })

  it("rejects an unknown op", () => {
    const r = parseAquiferOp({ op: "delete" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("search | read | publish")
  })

  describe("search", () => {
    it("requires q", () => {
      expect(parseAquiferOp({ op: "search" }).ok).toBe(false)
    })
    it("accepts q (+ optional limit) and trims", () => {
      const r = parseAquiferOp({ op: "search", q: "  chesed  ", limit: 3 })
      expect(r).toEqual({ ok: true, value: { op: "search", q: "chesed", limit: 3 } })
    })
    it("drops a non-numeric limit", () => {
      const r = parseAquiferOp({ op: "search", q: "ruth", limit: "lots" })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toEqual({ op: "search", q: "ruth" })
    })
  })

  describe("read", () => {
    it("requires a valid site path", () => {
      expect(parseAquiferOp({ op: "read" }).ok).toBe(false)
      expect(parseAquiferOp({ op: "read", path: "https://evil.example/x" }).ok).toBe(false)
      expect(parseAquiferOp({ op: "read", path: "/en/../../etc/passwd" }).ok).toBe(false)
    })
    it("accepts a passage path", () => {
      const r = parseAquiferOp({ op: "read", path: "/en/passages/RUT/1/8/" })
      expect(r).toEqual({ ok: true, value: { op: "read", path: "/en/passages/RUT/1/8/" } })
    })
  })

  describe("publish", () => {
    it("requires question, answer, and >=1 citation", () => {
      expect(parseAquiferOp({ op: "publish" }).ok).toBe(false)
      expect(
        parseAquiferOp({ op: "publish", question: "What is chesed?", answer: "Steadfast love." }).ok,
      ).toBe(false)
      expect(
        parseAquiferOp({
          op: "publish",
          question: "What is chesed?",
          answer: "Steadfast love.",
          citations: [],
        }).ok,
      ).toBe(false)
    })
    it("requires a url on each citation", () => {
      const r = parseAquiferOp({
        op: "publish",
        question: "q",
        answer: "a",
        citations: [{ title: "no url" }],
      })
      expect(r.ok).toBe(false)
    })
    it("defaults status to answered and keeps optional citation fields", () => {
      const r = parseAquiferOp({
        op: "publish",
        question: "What does chesed mean?",
        answer: "Covenant faithfulness / steadfast love.",
        citations: [{ url: "https://bibletranslation.org/en/terms/chesed/", quote: "loyal love" }],
      })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.value.op).toBe("publish")
        if (r.value.op === "publish") {
          expect(r.value.status).toBe("answered")
          expect(r.value.citations).toEqual([
            { url: "https://bibletranslation.org/en/terms/chesed/", quote: "loyal love" },
          ])
        }
      }
    })
    it("honours status:undetermined", () => {
      const r = parseAquiferOp({
        op: "publish",
        question: "Inconclusive?",
        answer: "Sources disagree on the nuance.",
        status: "undetermined",
        citations: [{ url: "https://bibletranslation.org/en/terms/x/" }],
      })
      expect(r.ok).toBe(true)
      if (r.ok && r.value.op === "publish") expect(r.value.status).toBe("undetermined")
    })
  })
})
