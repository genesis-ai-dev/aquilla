/**
 * ModelListEditor — the managed allowed-models list. Verifies add (first model
 * auto-becomes both defaults), marking chat/agent, and removal (with default
 * reassignment). Rendered through a stateful harness since it's controlled.
 */
import { describe, it, expect } from "vitest"
import { useState } from "react"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { ModelListEditor, type ModelListValue } from "./ModelListEditor"

function Harness({ initial }: { initial: ModelListValue }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <ModelListEditor value={value} onChange={setValue} />
      <output data-testid="state">{JSON.stringify(value)}</output>
    </>
  )
}

const state = () => JSON.parse(screen.getByTestId("state").textContent!) as ModelListValue

describe("ModelListEditor", () => {
  it("adds the first model and makes it both defaults", () => {
    render(<Harness initial={{ models: [], chatModel: "", agentModel: "" }} />)
    fireEvent.change(screen.getByLabelText(/add a model id/i), { target: { value: "a/model" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))
    expect(state()).toEqual({ models: ["a/model"], chatModel: "a/model", agentModel: "a/model" })
  })

  it("ignores duplicate and empty additions", () => {
    render(<Harness initial={{ models: ["a/model"], chatModel: "a/model", agentModel: "a/model" }} />)
    fireEvent.change(screen.getByLabelText(/add a model id/i), { target: { value: "a/model" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))
    expect(state().models).toEqual(["a/model"])
  })

  it("marks a row as the agent model without touching the chat default", () => {
    render(
      <Harness initial={{ models: ["a/model", "b/model"], chatModel: "a/model", agentModel: "a/model" }} />,
    )
    const bRow = screen.getByText("b/model").closest("li")!
    fireEvent.click(within(bRow).getByRole("button", { name: /^Agent/i }))
    expect(state()).toMatchObject({ chatModel: "a/model", agentModel: "b/model" })
  })

  it("reassigns defaults when the selected model is removed", () => {
    render(
      <Harness initial={{ models: ["a/model", "b/model"], chatModel: "a/model", agentModel: "a/model" }} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /remove a\/model/i }))
    expect(state()).toEqual({ models: ["b/model"], chatModel: "b/model", agentModel: "b/model" })
  })
})
