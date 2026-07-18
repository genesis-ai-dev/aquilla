// DcsSyncBadge test (AQU-615 wave 3).
//
// Intent: the badge is the ONLY workspace-level hint that a project's source
// cells are upstream-owned by a Door43 link. It must (1) surface the pin
// (owner/repo @ ref) whenever a cursor exists, and (2) stay completely absent
// for ordinary projects — a stray "Door43" badge on a non-adapter project
// would be a false claim about who owns the source text.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { DcsSyncBadge } from "./DcsSyncBadge"
import type { DcsCursor } from "@/lib/dcs/types"

const CURSOR: DcsCursor = {
  owner: "unfoldingWord",
  repo: "en_ult",
  subject: "Aligned Bible",
  contentFormat: "usfm",
  trackMode: "release",
  ref: "v88",
  commitSha: "abc123",
  released: "2026-05-01T00:00:00Z",
  importedAt: "2026-05-02T00:00:00Z",
}

describe("DcsSyncBadge", () => {
  it("renders the pin (owner/repo @ ref) from the cursor", () => {
    render(<DcsSyncBadge cursor={CURSOR} />)
    const badge = screen.getByTestId("dcs-sync-badge")
    expect(badge.textContent).toContain("unfoldingWord/en_ult")
    expect(badge.textContent).toContain("v88")
  })

  it("renders nothing without a cursor", () => {
    const { container } = render(<DcsSyncBadge cursor={null} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId("dcs-sync-badge")).toBeNull()
  })

  it("is clickable (jump to Project Settings) when onClick is provided", () => {
    const onClick = vi.fn()
    render(<DcsSyncBadge cursor={CURSOR} onClick={onClick} />)
    fireEvent.click(screen.getByTestId("dcs-sync-badge"))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
