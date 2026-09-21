// "Direct the run" popover: sends a free-text steering direction, shows queued
// directions as chips (no per-chip dismiss in v1 — directions have no
// client-visible identity), and refreshes the run snapshot after a successful
// send so chips track what the server still holds queued.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react"
import { ContextualSteering } from "./ContextualSteering"
import {
  applyRemoteFrame as applyFrame,
  attachContextualRun,
  getContextualRunState,
  resetContextualRunStore,
  setContextualTransport,
  useContextualRunState,
  type ContextualRunSnapshot,
  type ContextualFrame,
  type ContextualTransport,
} from "@/lib/contextual/run-store"

const { sendMock, MockApiError, MockAuthError } = vi.hoisted(() => {
  class MockApiError extends Error {
    public status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  class MockAuthError extends MockApiError {
    constructor(message = "You need to be signed in to use contextual drafting.") {
      super(message, 401)
    }
  }
  return {
    sendMock: vi.fn<(runId: string, text: string) => Promise<SteeringResult>>(),
    MockApiError,
    MockAuthError,
  }
})

/** Mirrors `ContextualSteeringResult` without importing the mocked module. */
interface SteeringResult {
  intent: "direction" | "pause" | "stop"
  applied: boolean
  run: null
}

const DIRECTION_RESULT: SteeringResult = { intent: "direction", applied: false, run: null }

vi.mock("@/lib/contextual/transport", () => ({
  sendContextualSteering: sendMock,
  ContextualApiError: MockApiError,
  ContextualAuthError: MockAuthError,
}))

const RUN = "01920000-0000-7000-8000-000000000001"

function applyRemoteFrame(frame: ContextualFrame): void {
  applyFrame("p1", frame)
}

function runSnapshot(activeDirections: string[]): ContextualRunSnapshot {
  return {
    runId: RUN,
    fileId: "file-1",
    status: "running",
    phase: null,
    spanLabel: null,
    done: 2,
    total: 10,
    failed: 0,
    activeDirections,
  }
}

function makeTransport(overrides: Partial<ContextualTransport> = {}): ContextualTransport {
  return {
    fetchSnapshot: vi.fn(async () => ({ available: true, run: runSnapshot([]) })),
    start: vi.fn(async () => ({ runId: RUN })),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    continueRun: vi.fn(async () => {}),
    ...overrides,
  }
}

/** The pill's wiring in miniature: chips come from the live store state. */
function Harness() {
  const state = useContextualRunState()
  return (
    <ContextualSteering
      projectId="p1"
      fileId="file-1"
      runId={RUN}
      directions={state.activeDirections}
    />
  )
}

function openPopover() {
  fireEvent.click(screen.getByRole("button", { name: "Direct the run" }))
  return screen.getByTestId("contextual-steering-popover")
}

beforeEach(async () => {
  cleanup()
  resetContextualRunStore()
  sendMock.mockReset()
  sendMock.mockResolvedValue(DIRECTION_RESULT)
  setContextualTransport(makeTransport())
  await attachContextualRun("p1", "file-1")
  applyRemoteFrame({
    type: "contextual.run.state",
    runId: RUN,
    fileId: "file-1",
    targetLang: "",
    status: "running",
    done: 2,
    total: 10,
  })
})

describe("ContextualSteering", () => {
  it("send is disabled while the input is empty (and for whitespace)", () => {
    setContextualTransport(makeTransport())
    render(<Harness />)
    openPopover()
    const send = screen.getByRole("button", { name: "Send" })
    expect(send).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Direction for the agent"), {
      target: { value: "   " },
    })
    expect(send).toBeDisabled()
  })

  it("successful send posts the direction, clears the input, and refreshes chips from the snapshot", async () => {
    // The refreshed snapshot is authoritative for chips — it reports what the
    // server still holds queued for the next passage.
    setContextualTransport(
      makeTransport({
        fetchSnapshot: vi.fn(async () => ({
          available: true,
          run: runSnapshot(["Keep the tone formal"]),
        })),
      }),
    )
    sendMock.mockResolvedValue(DIRECTION_RESULT)
    render(<Harness />)
    openPopover()

    const input = screen.getByLabelText("Direction for the agent")
    fireEvent.change(input, { target: { value: "Keep the tone formal" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith(RUN, "Keep the tone formal")
      expect(screen.getByTestId("contextual-steering-chip")).toHaveTextContent(
        "Keep the tone formal",
      )
    })
    expect(input).toHaveValue("")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("failed send shows an inline message and keeps the typed text", async () => {
    setContextualTransport(makeTransport())
    sendMock.mockRejectedValue(new MockApiError("send steering failed: HTTP 500", 500))
    render(<Harness />)
    openPopover()

    const input = screen.getByLabelText("Direction for the agent")
    fireEvent.change(input, { target: { value: "Shorter sentences" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That direction didn't reach the agent. Try again.",
    )
    expect(input).toHaveValue("Shorter sentences")
    expect(screen.queryByTestId("contextual-steering-chip")).not.toBeInTheDocument()
  })

  it("signed-out failure surfaces the sign-in message", async () => {
    setContextualTransport(makeTransport())
    sendMock.mockRejectedValue(new MockAuthError())
    render(<Harness />)
    openPopover()

    fireEvent.change(screen.getByLabelText("Direction for the agent"), {
      target: { value: "Keep it short" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You need to be signed in to use contextual drafting.",
    )
  })

  it("does not reattach or mutate a different run after a delayed send resolves", async () => {
    let finishSend: (() => void) | undefined
    sendMock.mockImplementation(
      () =>
        new Promise<SteeringResult>((resolve) => {
          finishSend = () => resolve(DIRECTION_RESULT)
        }),
    )
    render(<Harness />)
    openPopover()

    fireEvent.change(screen.getByLabelText("Direction for the agent"), {
      target: { value: "Keep the old run formal" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(RUN, "Keep the old run formal"))

    const newScopeFetch = vi.fn(async () => ({ available: true as const, run: null }))
    setContextualTransport(makeTransport({ fetchSnapshot: newScopeFetch }))
    await attachContextualRun("p2", "file-2")

    await act(async () => { finishSend?.() })
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled())
    expect(getContextualRunState()).toMatchObject({
      projectId: "p2",
      fileId: "file-2",
      runId: null,
      activeDirections: [],
    })
    expect(newScopeFetch).toHaveBeenCalledTimes(1)
    expect(newScopeFetch).toHaveBeenCalledWith("p2", "file-2", "")
  })

  it("shows queued directions as chips with a count badge on the trigger", () => {
    setContextualTransport(makeTransport())
    applyRemoteFrame({
      type: "contextual.run.state",
      runId: RUN,
      fileId: "file-1",
      targetLang: "",
      status: "running",
      done: 2,
      total: 10,
    })
    render(
      <ContextualSteering
        projectId="p1"
        fileId="file-1"
        runId={RUN}
        directions={["Keep dialogue formal", "Prefer short sentences"]}
      />,
    )
    expect(screen.getByTestId("contextual-steering-count")).toHaveTextContent("2")
    openPopover()
    const chips = screen.getAllByTestId("contextual-steering-chip")
    expect(chips.map((c) => c.textContent)).toEqual([
      "Keep dialogue formal",
      "Prefer short sentences",
    ])
    // v1 has no per-chip dismissal — chips are plain text, not buttons.
    for (const chip of chips) expect(chip.querySelector("button")).toBeNull()
  })
})

// AQU-1299: "stop"/"pause" typed here controls the run. The classifier runs
// client-side only to label the button and to keep a command from ever being
// shown as a queued direction — the server's answer is what gets reported.
describe("ContextualSteering run commands", () => {
  it("labels the send button for a stop-shaped message and never queues a chip", async () => {
    render(<Harness />)
    openPopover()

    fireEvent.change(screen.getByLabelText("Direction for the agent"), {
      target: { value: "stop" },
    })
    sendMock.mockResolvedValue({ intent: "stop", applied: true, run: null })
    const send = screen.getByRole("button", { name: "Stop the run" })
    fireEvent.click(send)

    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(RUN, "stop"))
    expect(await screen.findByTestId("contextual-steering-command-result")).toHaveTextContent(
      "Autopilot stopped.",
    )
    expect(screen.queryByTestId("contextual-steering-chip")).not.toBeInTheDocument()
  })

  it("labels a pause-shaped message and reports the pause request", async () => {
    render(<Harness />)
    openPopover()

    fireEvent.change(screen.getByLabelText("Direction for the agent"), {
      target: { value: "hold on" },
    })
    sendMock.mockResolvedValue({ intent: "pause", applied: true, run: null })
    fireEvent.click(screen.getByRole("button", { name: "Pause the run" }))

    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(RUN, "hold on"))
    expect(await screen.findByTestId("contextual-steering-command-result")).toHaveTextContent(
      "Pause requested.",
    )
  })

  it("says nothing changed when the run was not working", async () => {
    render(<Harness />)
    openPopover()

    fireEvent.change(screen.getByLabelText("Direction for the agent"), {
      target: { value: "stop" },
    })
    sendMock.mockResolvedValue({ intent: "stop", applied: false, run: null })
    fireEvent.click(screen.getByRole("button", { name: "Stop the run" }))

    expect(await screen.findByTestId("contextual-steering-command-result")).toHaveTextContent(
      "Autopilot wasn’t working, so nothing changed.",
    )
    expect(screen.queryByTestId("contextual-steering-chip")).not.toBeInTheDocument()
  })

  it("keeps an instruction that merely contains “stop” as a direction", async () => {
    setContextualTransport(
      makeTransport({
        fetchSnapshot: vi.fn(async () => ({
          available: true,
          run: runSnapshot(["stop using contractions in narration"]),
        })),
      }),
    )
    render(<Harness />)
    openPopover()

    fireEvent.change(screen.getByLabelText("Direction for the agent"), {
      target: { value: "stop using contractions in narration" },
    })
    // Still the plain Send button: this is steering, not a command.
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() =>
      expect(screen.getByTestId("contextual-steering-chip")).toHaveTextContent(
        "stop using contractions in narration",
      ),
    )
    expect(
      screen.queryByTestId("contextual-steering-command-result"),
    ).not.toBeInTheDocument()
  })
})
