/**
 * AQU-432: "Do this later" skip is prominently discoverable in the ProjectStep.
 *
 * Covers:
 *  - Skip button is rendered as a visible Button (not a tiny text link)
 *  - Skip button appears before the Back affordance so it is above the fold
 *  - Clicking skip calls onSkip without calling onCreated
 *  - Project creation form is still reachable (create is not removed)
 *  - No-session variant also exposes a prominent skip Button
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProjectStep } from "../steps/ProjectStep"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("uuid", () => ({ v4: () => "test-uuid" }))
vi.mock("@/lib/store/project-index", () => ({
  createProject: vi.fn(),
}))
vi.mock("@/lib/frontier/members", () => ({
  createRemoteProject: vi.fn(),
}))

// Session hook — default: signed-in user. Individual tests may override.
let mockSession: { jwt: string; username: string } | null = {
  jwt: "tok",
  username: "alice",
}
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: mockSession }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderStep(overrides: Partial<React.ComponentProps<typeof ProjectStep>> = {}) {
  const onCreated = vi.fn()
  const onBack = vi.fn()
  const onSkip = vi.fn()

  render(
    <ProjectStep
      displayName="Alice"
      onCreated={onCreated}
      onBack={onBack}
      onSkip={onSkip}
      {...overrides}
    />,
  )
  return { onCreated, onBack, onSkip }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSession = { jwt: "tok", username: "alice" }
})

// ---------------------------------------------------------------------------
// Tests — signed-in path
// ---------------------------------------------------------------------------

describe("ProjectStep — signed-in: skip affordance prominence (AQU-432)", () => {
  it("renders a <button> element labelled 'Do this later' (not a tiny text node)", () => {
    renderStep()
    // getByRole throws if not found — asserts existence AND correct role.
    const skipBtn = screen.getByRole("button", { name: /do this later/i })
    expect(skipBtn).toBeInTheDocument()
  })

  it("skip button appears in the DOM before the Back button (above the fold)", () => {
    renderStep()
    const allButtons = screen.getAllByRole("button")
    const skipIdx = allButtons.findIndex((b) => /do this later/i.test(b.textContent ?? ""))
    const backIdx = allButtons.findIndex((b) => /back/i.test(b.textContent ?? ""))
    // Skip must appear earlier in the DOM than the Back affordance.
    expect(skipIdx).toBeGreaterThanOrEqual(0)
    expect(backIdx).toBeGreaterThanOrEqual(0)
    expect(skipIdx).toBeLessThan(backIdx)
  })

  it("clicking skip calls onSkip and does NOT call onCreated", () => {
    const { onSkip, onCreated } = renderStep()
    fireEvent.click(screen.getByRole("button", { name: /do this later/i }))
    expect(onSkip).toHaveBeenCalledOnce()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it("project creation form is still present so users who want to create can", () => {
    renderStep()
    expect(screen.getByRole("button", { name: /create project/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/project title/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests — no-session path
// ---------------------------------------------------------------------------

describe("ProjectStep — no session: skip affordance prominence (AQU-432)", () => {
  beforeEach(() => {
    mockSession = null
  })

  it("renders a <button> element labelled 'Do this later' even without a session", () => {
    renderStep()
    const skipBtn = screen.getByRole("button", { name: /do this later/i })
    expect(skipBtn).toBeInTheDocument()
  })

  it("clicking skip in no-session state calls onSkip without calling onCreated", () => {
    const { onSkip, onCreated } = renderStep()
    fireEvent.click(screen.getByRole("button", { name: /do this later/i }))
    expect(onSkip).toHaveBeenCalledOnce()
    expect(onCreated).not.toHaveBeenCalled()
  })
})
