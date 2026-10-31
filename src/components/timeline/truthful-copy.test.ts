// AQU-2259: three sentences that said something the app does not do.
import { describe, it, expect } from "vitest"
import { translate } from "@/lib/i18n/translate"
import { denialMessageForEvent, type DenialT } from "@/lib/permissions/denial"
import { ROLE, resolveRoleName } from "@/lib/frontier/roles"

const t: DenialT = (key, vars) => translate(undefined, key, vars)

describe("sentences that match the app (AQU-2259)", () => {
  it("the never-paired notice points at the Pairings drawer's button, not a checkbox the dialog lacks", () => {
    const button = t("editor.timeline.cueLinkRepairAll")
    const notice = t("editor.timeline.neverPaired", { repairAll: button })
    expect(notice).toContain(`"${button}"`)
    expect(notice).not.toMatch(/tick|checkbox|re-import/i)
  })

  it("the film-link refusal names the floor the policy enforces: Project lead (AQU-2230)", () => {
    const refusal = denialMessageForEvent(t, "file.video.set", ROLE.CONTRIBUTOR, ROLE.CONTRIBUTOR)
    expect(refusal).toContain(resolveRoleName(t, ROLE.PROJECT_LEAD))
    expect(refusal).not.toMatch(/at least Contributor/)
  })

  it("the Link a video dialog does not promise the video always plays muted", () => {
    const description = t("editor.timeline.linkVideoDescription")
    expect(description).not.toMatch(/muted and in step/)
    expect(description).toMatch(/uploaded recording/)
    expect(description).toMatch(/film on YouTube keeps its own sound/)
  })
})
