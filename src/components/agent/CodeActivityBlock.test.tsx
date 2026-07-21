/**
 * CodeActivityBlock tests — collapsed chip shows language + running/duration
 * state; expanding reveals stdout/stderr with the truncation notice.
 */

import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { CodeActivityItem } from "@/lib/agent/run-state"
import { CodeActivityBlock } from "./CodeActivityBlock"

function item(overrides: Partial<CodeActivityItem> = {}): CodeActivityItem {
  return {
    id: "i0",
    kind: "code",
    language: "python",
    codePreview: "print('hi')",
    ...overrides,
  }
}

describe("CodeActivityBlock", () => {
  it("shows a running indicator while durationMs is unset", () => {
    render(<CodeActivityBlock item={item()} />)
    expect(screen.getByLabelText("Code running")).toBeInTheDocument()
    expect(screen.getByText("python")).toBeInTheDocument()
  })

  it("shows the elapsed time once settled, and stdout/stderr when expanded", () => {
    render(
      <CodeActivityBlock
        item={item({ stdout: "hi\n", stderr: "", truncated: false, durationMs: 128 })}
      />,
    )
    expect(screen.getByText("128ms")).toBeInTheDocument()
    expect(screen.queryByText("hi")).not.toBeInTheDocument() // collapsed by default

    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("stdout")).toBeInTheDocument()
    expect(screen.getByText("hi")).toBeInTheDocument()
  })

  it("surfaces the truncation notice when the sandbox capped output", () => {
    render(
      <CodeActivityBlock
        item={item({ stdout: "x".repeat(10), stderr: "", truncated: true, durationMs: 5 })}
      />,
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText(/Output truncated/)).toBeInTheDocument()
  })

  it("shows stderr distinctly when present", () => {
    render(<CodeActivityBlock item={item({ stdout: "", stderr: "boom", truncated: false, durationMs: 5 })} />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("stderr")).toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  it("shows a (no output) fallback when stdout and stderr are both empty", () => {
    render(<CodeActivityBlock item={item({ stdout: "", stderr: "", truncated: false, durationMs: 5 })} />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("(no output)")).toBeInTheDocument()
  })
})
