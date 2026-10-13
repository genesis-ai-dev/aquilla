// AQU-1938: the "N projects …" line under an org default opens a list of the
// projects behind the count, each linking to where its own value is set.
import { describe, it, expect, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { OverrideStatus } from "./OverrideStatus"
import type { OverrideProjectList } from "@/lib/sync/override-projects"

const href = (id: string) => `/project/${id}/settings/validation`

function renderStatus(props: Partial<Parameters<typeof OverrideStatus>[0]> = {}) {
  return render(
    <MemoryRouter>
      <OverrideStatus count={2} kind="number" projectHref={href} {...props} />
    </MemoryRouter>,
  )
}

const list = (total: number, names: string[]): OverrideProjectList => ({
  total,
  projects: names.map((name, i) => ({ id: `p${i + 1}`, name })),
})

describe("OverrideStatus project list (AQU-1938)", () => {
  it("the count opens a list of the projects, each linking to where its own value is set", async () => {
    renderStatus({ projects: list(2, ["Genesis", "Exodus"]) })
    const toggle = screen.getByRole("button", { name: "2 projects set their own number" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("list")).toBeNull()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    const items = within(screen.getByRole("list")).getAllByRole("listitem")
    expect(items.map((item) => item.textContent)).toEqual(["Genesis", "Exodus"])
    expect(screen.getByRole("link", { name: "Genesis" })).toHaveAttribute("href", "/project/p1/settings/validation")
    expect(screen.getByRole("link", { name: "Exodus" })).toHaveAttribute("href", "/project/p2/settings/validation")
    expect(toggle).toHaveAttribute("aria-controls", screen.getByRole("list").id)

    await userEvent.click(toggle)
    expect(screen.queryByRole("list")).toBeNull()
  })

  it("ends a capped list with how many more there are", async () => {
    const names = Array.from({ length: 50 }, (_, i) => `Book ${i + 1}`)
    renderStatus({ count: 55, projects: list(55, names) })
    await userEvent.click(screen.getByRole("button", { name: "55 projects set their own number" }))
    const items = within(screen.getByRole("list")).getAllByRole("listitem")
    expect(items).toHaveLength(51)
    expect(items[50].textContent).toBe("and 5 more")
    expect(within(items[50]).queryByRole("link")).toBeNull()
  })

  it("counts the projects the person may not see in that last line, without naming them", async () => {
    renderStatus({ count: 3, kind: "stricter", projects: list(3, ["Genesis"]) })
    await userEvent.click(screen.getByRole("button", { name: "3 projects are stricter than this" }))
    const items = within(screen.getByRole("list")).getAllByRole("listitem")
    expect(items.map((item) => item.textContent)).toEqual(["Genesis", "and 2 more"])
  })

  it("stays plain text when no project can be named (or an older server sent none)", () => {
    const { rerender } = renderStatus({ count: 1, projects: list(1, []) })
    expect(screen.getByTestId("override-status").textContent).toBe("1 project sets its own number")
    expect(screen.queryByRole("button")).toBeNull()
    rerender(
      <MemoryRouter>
        <OverrideStatus count={1} kind="number" projectHref={href} projects={null} />
      </MemoryRouter>,
    )
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("keeps the Reset link beside the count, and it still only opens the confirmation", async () => {
    const onReset = vi.fn()
    renderStatus({ projects: list(2, ["Genesis", "Exodus"]), onReset })
    const line = screen.getByTestId("override-status")
    expect(line.textContent).toBe("2 projects set their own number · Reset to default")
    await userEvent.click(screen.getByRole("button", { name: "2 projects set their own number" }))
    expect(onReset).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Reset to default" }))
    expect(onReset).toHaveBeenCalledOnce()
  })
})
