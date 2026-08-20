/**
 * ModelListEditor — the managed allowed-models list.
 *
 * Two kinds of role live on this list and they behave differently on purpose:
 * chat and agent are REQUIRED (the first model added claims them, and removing
 * the holder reassigns), while the autopilot's fast and deep tiers are
 * OPTIONAL (nothing claims them implicitly, clicking an active one clears it,
 * and removing the holder falls back rather than reassigning). Reassigning a
 * tier an admin never chose would silently change what the pipeline runs on.
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

const value = (over: Partial<ModelListValue> = {}): ModelListValue => ({
  models: [],
  chatModel: "",
  agentModel: "",
  fastModel: "",
  deepModel: "",
  ...over,
})

describe("ModelListEditor", () => {
  it("adds the first model and makes it both defaults", () => {
    render(<Harness initial={value()} />)
    fireEvent.change(screen.getByLabelText(/add a model id/i), { target: { value: "a/model" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))
    expect(state()).toEqual(
      value({ models: ["a/model"], chatModel: "a/model", agentModel: "a/model" }),
    )
  })

  it("does not let the first model claim the optional autopilot tiers", () => {
    render(<Harness initial={value()} />)
    fireEvent.change(screen.getByLabelText(/add a model id/i), { target: { value: "a/model" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))
    expect(state().fastModel).toBe("")
    expect(state().deepModel).toBe("")
  })

  it("ignores duplicate and empty additions", () => {
    render(<Harness initial={value({ models: ["a/model"], chatModel: "a/model", agentModel: "a/model" })} />)
    fireEvent.change(screen.getByLabelText(/add a model id/i), { target: { value: "a/model" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))
    expect(state().models).toEqual(["a/model"])
  })

  it("marks a row as the agent model without touching the chat default", () => {
    render(
      <Harness
        initial={value({ models: ["a/model", "b/model"], chatModel: "a/model", agentModel: "a/model" })}
      />,
    )
    const bRow = screen.getByText("b/model").closest("li")!
    fireEvent.click(within(bRow).getByRole("button", { name: /^Agent/i }))
    expect(state()).toMatchObject({ chatModel: "a/model", agentModel: "b/model" })
  })

  it("sets and then clears the fast tier — it is optional, so the toggle is a toggle", () => {
    render(
      <Harness
        initial={value({ models: ["a/model", "b/model"], chatModel: "a/model", agentModel: "a/model" })}
      />,
    )
    const bRow = screen.getByText("b/model").closest("li")!
    fireEvent.click(within(bRow).getByRole("button", { name: /^Fast/i }))
    expect(state().fastModel).toBe("b/model")
    fireEvent.click(within(bRow).getByRole("button", { name: /^Fast/i }))
    expect(state().fastModel).toBe("")
  })

  it("keeps the fast and deep tiers independent of each other", () => {
    render(
      <Harness
        initial={value({ models: ["a/model", "b/model"], chatModel: "a/model", agentModel: "a/model" })}
      />,
    )
    const aRow = screen.getByText("a/model").closest("li")!
    const bRow = screen.getByText("b/model").closest("li")!
    fireEvent.click(within(aRow).getByRole("button", { name: /^Fast/i }))
    fireEvent.click(within(bRow).getByRole("button", { name: /^Deep/i }))
    expect(state()).toMatchObject({ fastModel: "a/model", deepModel: "b/model" })
  })

  it("reassigns the required defaults when the selected model is removed", () => {
    render(
      <Harness
        initial={value({ models: ["a/model", "b/model"], chatModel: "a/model", agentModel: "a/model" })}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /remove a\/model/i }))
    expect(state()).toEqual(
      value({ models: ["b/model"], chatModel: "b/model", agentModel: "b/model" }),
    )
  })

  it("CLEARS an optional tier when its model is removed rather than reassigning it", () => {
    render(
      <Harness
        initial={value({
          models: ["a/model", "b/model"],
          chatModel: "b/model",
          agentModel: "b/model",
          fastModel: "a/model",
          deepModel: "a/model",
        })}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /remove a\/model/i }))
    expect(state()).toMatchObject({ fastModel: "", deepModel: "" })
  })
})
