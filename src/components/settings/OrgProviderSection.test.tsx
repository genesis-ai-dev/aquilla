// AQU-2263: the organization's Gemini key says which key is in use. Voices are
// made in each person's browser and never receive it, so a saved key says so.
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { OrgProviderSection } from "./OrgProviderSection"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

function orgSettings(keys: Record<string, string>, canEditOrgKeys = true): UseOrgSettings {
  return {
    orgProviderKeys: keys,
    canEditOrgKeys,
    hasFetched: true,
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
  } as unknown as UseOrgSettings
}

describe("OrgProviderSection — which key is in use", () => {
  it("a saved key says voices don't use it yet", () => {
    render(<OrgProviderSection orgSettings={orgSettings({ "gemini-tts": "AIza-org" })} />)
    expect(screen.getByTestId("org-gemini-key-in-use")).toHaveTextContent(
      "Saved, but voices don't use the organization's key yet: each project or person still needs their own.",
    )
  })

  it("the same for someone who only sees it hidden", () => {
    render(<OrgProviderSection orgSettings={orgSettings({ "gemini-tts": "••••••••" }, false)} />)
    expect(screen.getByTestId("org-gemini-key-in-use")).toHaveTextContent(/voices don't use/)
  })

  it("no key", () => {
    render(<OrgProviderSection orgSettings={orgSettings({})} />)
    expect(screen.getByTestId("org-gemini-key-in-use")).toHaveTextContent("No organization key.")
  })
})
