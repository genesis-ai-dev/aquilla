// EgressResultsPanel rendering rules pinned here:
// - the engine's final org-level updates (projectName "" with projectIndex ===
//   projectCount, emitted while packaging the combined zip) render as a bare
//   phase label — no "— name (n+1 of n)" nonsense — and progress never reads
//   past 100%;
// - per-file transparency notes[] from the manifest (fallback-format /
//   source-doc honesty notes) surface in the done branch alongside skips: the
//   export DID write those entries, just not exactly as requested, and hiding
//   that breaks the fail-loud contract.

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { EgressResultsPanel } from "./EgressResultsPanel"
import type { EgressManifest, EgressProgressUpdate } from "@/lib/egress/types"

function progress(overrides: Partial<EgressProgressUpdate>): EgressProgressUpdate {
  return {
    phase: "text",
    projectName: "Genesis",
    projectIndex: 0,
    projectCount: 2,
    done: 0,
    total: 0,
    ...overrides,
  }
}

function manifestWith(projects: EgressManifest["projects"]): EgressManifest {
  return {
    generatedAt: "2026-08-13T00:00:00Z",
    org: { id: 1, name: "Acme" },
    options: {
      textMode: "original",
      convertFormat: "txt",
      lanes: [""],
      includeSourceDocs: true,
      audioMode: "none",
      useCache: true,
    },
    projects,
  }
}

describe("EgressResultsPanel running sentinel", () => {
  it("renders the final packaging update as a bare phase label", () => {
    render(
      <EgressResultsPanel
        state={{
          kind: "running",
          progress: progress({
            phase: "zipping",
            projectName: "",
            projectIndex: 2,
            projectCount: 2,
          }),
        }}
        onCancel={vi.fn()}
      />,
    )

    const line = screen.getByTestId("egress-status-line")
    expect(line).toHaveTextContent("Packaging…")
    // No "— <name> (3 of 2)" suffix on the org-level sentinel.
    expect(line.textContent).not.toMatch(/of 2/)
    expect(line.textContent).not.toMatch(/—/)
  })

  it("still renders the per-project suffix for normal updates", () => {
    render(
      <EgressResultsPanel
        state={{
          kind: "running",
          progress: progress({ phase: "text", projectName: "Genesis", projectIndex: 1 }),
        }}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId("egress-status-line")).toHaveTextContent(
      "Exporting text — Genesis (2 of 2)",
    )
  })

  it("clamps progress to 100% on the final done sentinel", () => {
    render(
      <EgressResultsPanel
        state={{
          kind: "running",
          progress: progress({
            phase: "done",
            projectName: "",
            projectIndex: 2,
            projectCount: 2,
            done: 2,
            total: 2,
          }),
        }}
        onCancel={vi.fn()}
      />,
    )

    // (projectIndex + 1) / projectCount would be 150% — must clamp.
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100")
  })
})

describe("EgressResultsPanel done notes", () => {
  it("surfaces per-file transparency notes alongside skips", () => {
    const manifest = manifestWith([
      {
        projectId: "p1",
        projectName: "Genesis",
        freshnessKey: "k1",
        fromCache: false,
        files: [
          {
            fileId: "f1",
            fileName: "intro.docx",
            entries: ["Genesis/intro.txt"],
            skipped: [{ scope: "intro.docx source", reason: "original bytes unavailable" }],
            notes: ["no round-trip exporter for docx — exported as txt"],
          },
        ],
        errors: [],
      },
    ])

    render(<EgressResultsPanel state={{ kind: "done", manifest }} onCancel={vi.fn()} />)

    expect(
      screen.getByText("Note: intro.docx: no round-trip exporter for docx — exported as txt"),
    ).toBeInTheDocument()
    // Skips still render — notes are additive, not a replacement.
    expect(
      screen.getByText("Skipped intro.docx source: original bytes unavailable"),
    ).toBeInTheDocument()
  })
})
