import { describe, expect, it } from "vitest"
import { t } from "@/lib/i18n/standalone"
import { ROLE } from "@/lib/frontier/roles"
import { describeGrant, grantButtonLabel, grantProjectName } from "./grant-scope-sentence"

describe("describeGrant", () => {
  it("names a single lane on a project", () => {
    const copy = describeGrant(t, {
      names: ["Maria"],
      roleLevel: ROLE.CONTRIBUTOR,
      scope: { kind: "project", projectName: "Mark", lanes: ["French"] },
    })
    expect(copy.sentence).toBe("Maria will join as a Contributor on Mark, French lane only")
    expect(copy.scopeEcho).toBe("French lane only")
    expect(grantButtonLabel(t, "Add", copy.scopeEcho)).toBe("Add — French lane only")
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

  it("names a project grant with no lane scope as every lane", () => {
    const copy = describeGrant(t, {
      names: ["Maria"],
      roleLevel: ROLE.CONTRIBUTOR,
      scope: { kind: "project", projectName: "Mark", lanes: "all" },
    })
    expect(copy.sentence).toBe("Maria will join as a Contributor on Mark — every lane")
    expect(copy.scopeEcho).toBe("every lane")
  })

  it("names an open link and an email", () => {
    expect(
      describeGrant(t, {
        link: true,
        roleLevel: ROLE.CONTRIBUTOR,
        scope: { kind: "project", projectName: "Mark", lanes: "all" },
      }).sentence,
    ).toBe("Anyone with this link will join as a Contributor on Mark — every lane")
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
    ).toBe("Maria and Luis will join as Contributors on Mark, French and Spanish lanes only")
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
