/**
 * SearchResultsView.i18n.test.tsx — AQU-511 wave-3 finding 3.
 *
 * The header's "for <query>" clause and the footer's "<results> in <files>"
 * summary used to be built from separate translated fragments concatenated
 * in a fixed JSX order (`t("search.expanded.forQueryPrefix")` then a literal
 * quoted query; `t("search.resultCount")` then `t("search.expanded.countsJoiner")`
 * then `t("search.expanded.fileCount")`). No translation could ever move the
 * query before "for", or the file count before the result count — the JSX
 * fragment order was the only order that could ever render, regardless of
 * what a translator wrote.
 *
 * They are now each a single catalog key
 * (`search.expanded.forQuery`, `search.expanded.summary`) holding the whole
 * sentence with placeholders, so the translator's word order is whatever the
 * resolved string says. This file proves that by swapping the order in a
 * mocked translation and asserting the rendered output follows it — a
 * reordering that was structurally impossible under the old fragment-gluing
 * code, which never even looked at the order of a `{query}`/`{results}`/
 * `{files}` placeholder because there wasn't one.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { interpolate, translate } from "@/lib/i18n/translate"
import { en, type MessageKey } from "@/lib/i18n/messages/en"
import { SearchResultsView } from "./SearchResultsView"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"

const REORDERED_TEMPLATES: Record<string, string> = {
  "search.expanded.forQuery": "«{query}» query",
  "search.expanded.summary": "{files} :: {results}",
}

vi.mock("@/lib/i18n/I18nProvider", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/i18n/I18nProvider")>(
      "@/lib/i18n/I18nProvider",
    )
  return {
    ...actual,
    useT: () => (key: MessageKey, vars?: Record<string, string | number>) => {
      const reordered = REORDERED_TEMPLATES[key]
      if (reordered) return interpolate(reordered, vars)
      return translate(en, key, vars, "en")
    },
  }
})

function makeResult(
  overrides: Partial<WorkspaceSearchResult> = {},
): WorkspaceSearchResult {
  return {
    cellId: "cell-1",
    fileId: "file-1",
    fileName: "Genesis.sfm",
    original: "In the beginning God created",
    translated: "Au commencement Dieu créa",
    context: "GEN 1:1",
    matchedFields: new Set(["original"]),
    matchCount: 1,
    matchedTokens: ["god"],
    snippet: "In the beginning God created",
    rank: 1,
    ...overrides,
  }
}

describe("SearchResultsView — translated word order (AQU-511 finding 3)", () => {
  it("follows the translation's placement of the query, not English's", () => {
    render(
      <SearchResultsView
        query="God"
        results={[makeResult()]}
        onJumpToResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // The mocked catalog puts the query BEFORE the word "query", the reverse
    // of English's "for {query}". This would be unreachable if the query
    // were interpolated into a separately-translated fixed-order fragment.
    expect(screen.getByText("«God» query")).toBeInTheDocument()
  })

  it("follows the translation's placement of file count before result count", () => {
    const results = [
      makeResult({ cellId: "c1" }),
      makeResult({ cellId: "c2", context: "GEN 1:2" }),
    ]
    render(
      <SearchResultsView
        query="God"
        results={results}
        onJumpToResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // The mocked catalog puts the file count BEFORE the result count, the
    // reverse of English's "{results} in {files}". This would be
    // unreachable if result count and file count were two separately
    // translated fragments joined by a third, position-fixed "in" key.
    expect(screen.getByText("1 file :: 2 results")).toBeInTheDocument()
  })
})
