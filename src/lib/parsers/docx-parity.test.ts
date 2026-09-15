// AQU-1237 — DOCX import parity, browser side.
//
// The Agent API now parses .docx server-side by calling this exact function
// (sync-worker/src/external/import-parse.ts). This test pins what the BROWSER
// import produces for the shared fixture; sync-worker's external-import-parse
// suite pins the same expectation for the REST parse route. Both compare
// against DOCX_PARITY_EXPECTED_CELLS, so a divergence fails on one side or the
// other rather than shipping two importers that quietly disagree.

import { describe, it, expect } from "vitest"
import { extractDocxStrings } from "./docx"
import {
  DOCX_PARITY_EXPECTED_CELLS,
  buildDocxParityFixture,
} from "./__fixtures__/docx-parity"

describe("DOCX import parity fixture (browser path)", () => {
  it("produces the shared expected cells", async () => {
    const bytes = buildDocxParityFixture()
    const strings = await extractDocxStrings(bytes.buffer as ArrayBuffer)

    expect(
      strings.map((s) => ({
        original: s.original,
        context: s.context,
        type: s.type,
        ...(s.originalHtml !== undefined ? { originalHtml: s.originalHtml } : {}),
        paragraphStart: s.paragraphStart === true,
      })),
    ).toEqual(DOCX_PARITY_EXPECTED_CELLS)
  })

  it("reads STORED (uncompressed) archive members, not just deflated ones", async () => {
    // The fixture is written with method 0; docx.test.ts covers method 8 via
    // JSZip. Both paths must reach the same parser.
    const strings = await extractDocxStrings(buildDocxParityFixture().buffer as ArrayBuffer)
    expect(strings.length).toBeGreaterThan(0)
  })
})
