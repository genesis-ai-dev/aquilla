// src/components/living-memory/PredictionPromptSection.test.tsx
import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { PredictionPromptSection } from "./PredictionPromptSection"

/**
 * AQU-912: this pane's help text (`projectSettings.systemPrompt.navDescription`,
 * also the Settings cross-link's blurb) used to read "What this project is
 * producing and how translations should read" — a description of the
 * translation brief, on the field that drives the AI. Two partner users read
 * the brief and the AI instructions as one field in two days. The guard is on
 * the rendered help text, because the confusion was the copy.
 */
describe("PredictionPromptSection", () => {
  const noopPatch = async () => ({ kind: "ok" }) as const

  it("describes the prompt as the AI's standing instructions, not what the project produces", () => {
    render(
      <PredictionPromptSection stored={undefined} canEdit reasonCannotEdit={null} patch={noopPatch} />,
    )

    fireEvent.click(screen.getByRole("button", { expanded: false }))

    expect(screen.getByText(/standing instructions behind every AI draft/i)).toBeTruthy()
    expect(screen.queryByText(/what this project is producing/i)).toBeNull()
  })
})
