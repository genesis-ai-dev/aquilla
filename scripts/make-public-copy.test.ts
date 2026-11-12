/**
 * AQU-1286 — what the public copy must leave behind.
 *
 * The two questions this script answers are "is this path partner-owned?" and
 * "does this text carry a partner's copyright?". Both are pure, and both are the
 * difference between publishing cleanly and publishing someone else's IP, so they
 * are tested directly rather than through a filesystem run.
 */

import { describe, it, expect } from "vitest"
import { findCopyrightNotices, isPartnerPath, publicFiles } from "./make-public-copy"

describe("isPartnerPath", () => {
  it("matches a partner-integrations folder at any depth", () => {
    expect(isPartnerPath("src/partner-integrations/biblica/register.ts")).toBe(true)
    expect(isPartnerPath("e2e/specs/partner-integrations/biblica/import-ebl.spec.ts")).toBe(true)
    expect(isPartnerPath("partner-integrations/x.ts")).toBe(true)
  })

  it("leaves the generic tree alone", () => {
    expect(isPartnerPath("src/lib/partners/registry.ts")).toBe(false)
    expect(isPartnerPath("src/lib/import.ts")).toBe(false)
  })

  it("does not match a file merely named after the convention", () => {
    // Only a whole path *segment* counts; a similarly-named file is generic code.
    expect(isPartnerPath("docs/partner-integrations.md")).toBe(false)
    expect(isPartnerPath("src/lib/partner-integrations-notes.ts")).toBe(false)
  })
})

describe("publicFiles", () => {
  it("drops partner paths and sorts what is left", () => {
    expect(publicFiles([
      "src/lib/import.ts",
      "src/partner-integrations/biblica/register.ts",
      "docs/PARTNER-INTEGRATIONS.md",
      "",
    ])).toEqual(["docs/PARTNER-INTEGRATIONS.md", "src/lib/import.ts"])
  })
})

describe("findCopyrightNotices", () => {
  it("catches the notices that ship inside partner fixtures", () => {
    expect(findCopyrightNotices("Copyright © 2017 by Biblica, Inc. All rights reserved worldwide."))
      .not.toEqual([])
    expect(findCopyrightNotices("text copyright 1995, 1996, 1998, 2014 by Biblica, Inc."))
      .not.toEqual([])
  })

  it("does not fire on a partner's name in neutral prose", () => {
    // A README or a doc may say which partners exist; that is not a copyright
    // notice, and failing on it would make the script impossible to keep green.
    expect(findCopyrightNotices("Biblica importers live in src/partner-integrations.")).toEqual([])
    expect(findCopyrightNotices("the Treasure Hunt Bible template")).toEqual([])
  })

  it("reports each distinct notice once", () => {
    const notices = findCopyrightNotices(
      "Copyright by Biblica, Inc.\nCopyright by Biblica, Inc.\n",
    )
    expect(new Set(notices).size).toBe(notices.length)
  })
})
