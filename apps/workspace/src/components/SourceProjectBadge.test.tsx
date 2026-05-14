import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { SourceProjectBadge } from "./SourceProjectBadge"

const navigateMock = vi.fn()
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  )
  return {
    ...actual,
    useNavigate: () => navigateMock,
  }
})

describe("SourceProjectBadge", () => {
  it("renders nothing when sourceProjectId is null", () => {
    const { container } = render(
      <MemoryRouter>
        <SourceProjectBadge sourceProjectId={null} />
      </MemoryRouter>,
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the project name when provided", () => {
    render(
      <MemoryRouter>
        <SourceProjectBadge
          sourceProjectId="src-1"
          sourceProjectName="Hebrew OT"
        />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Source: Hebrew OT/)).toBeInTheDocument()
  })

  it("falls back to 'linked upstream' when name is unknown", () => {
    render(
      <MemoryRouter>
        <SourceProjectBadge sourceProjectId="src-1" />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Source: linked upstream/)).toBeInTheDocument()
  })

  it("navigates to /project/<id> on click in non-readonly mode", () => {
    navigateMock.mockClear()
    render(
      <MemoryRouter>
        <SourceProjectBadge
          sourceProjectId="src-1"
          sourceProjectName="Hebrew OT"
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByTestId("source-project-badge"))
    expect(navigateMock).toHaveBeenCalledWith("/project/src-1")
  })

  it("renders as a non-clickable span in readonly mode", () => {
    navigateMock.mockClear()
    render(
      <MemoryRouter>
        <SourceProjectBadge
          sourceProjectId="src-1"
          sourceProjectName="Hebrew OT"
          readonly
        />
      </MemoryRouter>,
    )
    const el = screen.getByTestId("source-project-badge")
    expect(el.tagName.toLowerCase()).toBe("span")
    fireEvent.click(el)
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
