import { describe, expect, it } from "vitest"
import { t } from "@/lib/i18n/standalone"
import { ROLE } from "@/lib/frontier/roles"
import { laneOptionLabel } from "@/lib/lanes/lane-language"
import { describeGrant, grantButtonLabel, grantProjectName } from "./grant-scope-sentence"

describe("describeGrant", () => {
  it("names a single lane on a project", () => {
    const copy = describeGrant(t, {
      names: ["Maria"],
      roleLevel: ROLE.CONTRIBUTOR,
      scope: { kind: "project", projectName: "Mark", lanes: ["French"] },
    })
    expect(copy.sentence).toBe("Maria will join as a Contributor on Mark, French language lane only")
    expect(copy.scopeEcho).toBe("French language lane only")
    expect(grantButtonLabel(t, "Add", copy.scopeEcho)).toBe("Add — French language lane only")
  })

  // AQU-2027: someone already on the project at or above the picked role keeps
  // it — the Staff popover only limits them to the lane.
  it("says a person already on the project stays at their role", () => {
    const copy = describeGrant(t, {
      names: ["Maria"],
      roleLevel: ROLE.PROJECT_LEAD,
      stays: true,
      scope: { kind: "project", projectName: "Mark", lanes: ["French"] },
    })
    expect(copy.sentence).toBe("Maria stays a Project Lead on Mark, French language lane only")
    expect(copy.scopeEcho).toBe("French language lane only")
  })

  // AQU-2289: below Maintainer an organization role opens no project
  // (AQU-1107), so the add row must not promise "every project".
  it("never promises every project to an organization role below Maintainer", () => {
    for (const roleLevel of [ROLE.VIEWER, ROLE.CONTRIBUTOR, ROLE.PROJECT_LEAD]) {
      const copy = describeGrant(t, { names: ["Maria"], roleLevel, scope: { kind: "organization" } })
      expect(copy.sentence).not.toMatch(/every project/)
      expect(copy.scopeEcho).not.toMatch(/every project/)
    }
    const copy = describeGrant(t, { names: ["Maria"], roleLevel: ROLE.CONTRIBUTOR, scope: { kind: "organization" } })
    expect(copy.sentence).toBe(
      "Maria will join as a Contributor of the organization — no projects until added to one",
    )
    expect(grantButtonLabel(t, "Add", copy.scopeEcho)).toBe("Add — organization only")
  })

  it("names a maintainer of the whole organization", () => {
    const copy = describeGrant(t, {
      names: ["Maria"],
      roleLevel: ROLE.MAINTAINER,
      scope: { kind: "organization" },
    })
    expect(copy.sentence).toBe(
      "Maria will join as a Maintainer of the whole organization — every project",
    )
    expect(copy.scopeEcho).toBe("every project")
  })

  // AQU-2635: a project migrated from Codex can hold one target lane whose row
  // records no language and no name and whose tag is ''. Labelling it through
  // the shared helper is what keeps this sentence honest: a blank label was
  // filtered out below, the label list went empty, and the every-lane fallback
  // claimed "every language lane" for a grant that limits the person to that
  // one lane. Chained from the real helper so relabelling it cannot silently
  // reopen the gap.
  it("names a lane whose row records no language, instead of claiming every lane", () => {
    const label = laneOptionLabel(
      { id: "ln-main", role: "target", name: "", language: "", legacyTag: "" },
      t("org.memberLaneScopeEditor.mainLanguageFallback"),
    )
    const copy = describeGrant(t, {
      names: ["matthew_test"],
      roleLevel: ROLE.CONTRIBUTOR,
      scope: { kind: "project", projectName: "Dari_prs_The_Chosen_Audio", lanes: [label] },
    })
    expect(copy.sentence).toBe(
      "matthew_test will join as a Contributor on Dari_prs_The_Chosen_Audio, Main language language lane only",
    )
    expect(copy.scopeEcho).toBe("Main language language lane only")
    expect(copy.sentence).not.toContain("every language lane")
    expect(grantButtonLabel(t, "Add", copy.scopeEcho)).toBe("Add — Main language language lane only")
  })

  it("names a project grant with no lane scope as every lane", () => {
    const copy = describeGrant(t, {
      names: ["Maria"],
      roleLevel: ROLE.CONTRIBUTOR,
      scope: { kind: "project", projectName: "Mark", lanes: "all" },
    })
    expect(copy.sentence).toBe("Maria will join as a Contributor on Mark — every language lane")
    expect(copy.scopeEcho).toBe("every language lane")
  })

  // ── AQU-2358 ──
  it("names a project grant that includes no lane at all", () => {
    const copy = describeGrant(t, {
      names: ["Maria"],
      roleLevel: ROLE.CONTRIBUTOR,
      scope: { kind: "project", projectName: "Mark", lanes: "none" },
    })
    expect(copy.sentence).toBe("Maria will join as a Contributor on Mark — no language lanes")
    expect(copy.scopeEcho).toBe("no language lanes")
    // The point of the variant: it must not read like the every-lane grant.
    expect(copy.sentence).not.toMatch(/every language lane/)
  })

  it("names an open link and an email", () => {
    expect(
      describeGrant(t, {
        link: true,
        roleLevel: ROLE.CONTRIBUTOR,
        scope: { kind: "project", projectName: "Mark", lanes: "all" },
      }).sentence,
    ).toBe("Anyone with this link will join as a Contributor on Mark — every language lane")
    expect(
      describeGrant(t, {
        names: ["ada@example.com"],
        roleLevel: ROLE.MAINTAINER,
        scope: { kind: "organization" },
      }).sentence,
    ).toBe(
      "ada@example.com will join as a Maintainer of the whole organization — every project",
    )
  })

  it("uses a plural role when several people are staged", () => {
    expect(
      describeGrant(t, {
        names: ["Maria", "Luis"],
        roleLevel: ROLE.CONTRIBUTOR,
        scope: { kind: "project", projectName: "Mark", lanes: ["French", "Spanish"] },
      }).sentence,
    ).toBe("Maria and Luis will join as Contributors on Mark, French and Spanish language lanes only")
  })

  it("stays live before a person is chosen, and does not invent a lane list", () => {
    expect(
      describeGrant(t, {
        roleLevel: ROLE.REVIEWER,
        scope: { kind: "project", projectName: "Mark", lanes: "unknown" },
      }).sentence,
    ).toBe("They will join as a Reviewer on Mark")
    expect(grantProjectName(t, "  ")).toBe("this project")
    expect(grantProjectName(t, "Mark")).toBe("Mark")
  })
})
