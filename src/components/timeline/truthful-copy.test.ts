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

  it("the film-link refusal names the floor the policy enforces: Project Lead (AQU-2230)", () => {
    const refusal = denialMessageForEvent(t, "file.video.set", ROLE.CONTRIBUTOR, ROLE.CONTRIBUTOR)
    expect(refusal).toContain(resolveRoleName(t, ROLE.PROJECT_LEAD))
    expect(refusal).not.toMatch(/at least Contributor/)
  })

  it("the Link a video dialog does not promise the video always plays muted", () => {
    // Its one short line opens this text from a click (i) since import map D#17.
    const description = t("editor.timeline.linkVideoMore")
    expect(description).not.toMatch(/muted and in step/)
    expect(description).toMatch(/uploaded recording/)
    expect(description).toMatch(/film on YouTube keeps its own sound/)
  })

  it("Link a film's (i) says an uploaded recording is what plays in both timings (AQU-2253, browser pass Nov 9)", () => {
    // Since the review's film fix 1, following the recordings a streamed film
    // beside an uploaded recording is silent and the recording plays, as it
    // does following the source. The (i) still said the film's own sound
    // played there.
    const description = t("editor.timeline.linkVideoMore")
    expect(description).not.toMatch(/Following the recordings, the film plays with its own sound/)
    expect(description).toMatch(/you hear that recording and the film is muted, whether the file follows its source or its recordings/)
  })
})
