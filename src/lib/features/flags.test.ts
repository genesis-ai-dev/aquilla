import { describe, it, expect, afterEach } from "vitest"
import { FLAGS, isAutopilotVisible, isFlagEnabled } from "./flags"

describe("feature flags registry", () => {
  it("defines contextualTranslation, default OFF", () => {
    // AQU-1103 regression guard. Autopilot is opt-in: a project that has never
    // stored a value must not get its surfaces. This registry default is the
    // only thing that enables the feature for such a project, so asserting it
    // here is asserting the product rule, not restating the source.
    expect(FLAGS.contextualTranslation).toBeDefined()
    expect(FLAGS.contextualTranslation.default).toBe(false)
    expect(FLAGS.contextualTranslation.labelKey).toBe("autopilot.settings.controlsLabel")
    expect(FLAGS.contextualTranslation.descriptionKey).toBe("autopilot.settings.controlsDescription")
  })

  it("marks contextualTranslation legacy — read-only, never offered as a toggle", () => {
    // AQU-1246: the device-local switch is a grandfather now. It must stay in
    // the registry (deleting it would strand every device that stored `true`)
    // and it must stay `legacy` (un-marking it puts the one-click,
    // any-member switch back in project settings, which is the bug).
    expect(FLAGS.contextualTranslation.legacy).toBe(true)
  })
})

describe("isAutopilotVisible", () => {
  it("a project nobody opted in gets NO Autopilot surface", () => {
    // AQU-1246, the core rule: absent, not disabled. This is the exact shape
    // that was live in production — no opt-in of either kind on the record.
    expect(isAutopilotVisible({})).toBe(false)
    expect(isAutopilotVisible({ autopilotEnabled: undefined, experimentalFlags: undefined })).toBe(false)
    expect(isAutopilotVisible({ autopilotEnabled: false })).toBe(false)
    expect(isAutopilotVisible({ experimentalFlags: {} })).toBe(false)
  })

  it("the project-wide opt-in reveals the surface for every member and device", () => {
    // The replacement gate: server-stored, so one owner/lead switching it on
    // is what every member of the project reads — not a per-browser choice.
    expect(isAutopilotVisible({ autopilotEnabled: true })).toBe(true)
  })

  it("grandfathers a device that stored the legacy flag before the gate moved", () => {
    // Acceptance criterion: a project already using Autopilot keeps it
    // uninterrupted. Nobody's running autopilot may vanish because the gate
    // moved house.
    expect(
      isAutopilotVisible({ experimentalFlags: { contextualTranslation: true } }),
    ).toBe(true)
    // …including when the project-wide setting is explicitly off, which is the
    // real migration shape: the setting has never been written for these
    // projects, and an absent value must not evict them either.
    expect(
      isAutopilotVisible({
        autopilotEnabled: false,
        experimentalFlags: { contextualTranslation: true },
      }),
    ).toBe(true)
  })

  it("a legacy flag stored false does not block a project-wide opt-in", () => {
    // Someone who once switched the old device-local control off must still
    // see Autopilot once their lead opts the project in — the legacy flag is
    // a grandfather, never a veto.
    expect(
      isAutopilotVisible({
        autopilotEnabled: true,
        experimentalFlags: { contextualTranslation: false },
      }),
    ).toBe(true)
  })
})

describe("isFlagEnabled", () => {
  afterEach(() => {
    // Tests below temporarily extend the registry; keep it clean.
    delete FLAGS.__testDefaultOn
  })

  it("absent field falls back to the registry default", () => {
    // AQU-1103: a project nobody has touched reads OFF. This is the exact shape
    // that was live in production — no `experimentalFlags` on the record at all.
    expect(isFlagEnabled({}, "contextualTranslation")).toBe(false)
    expect(isFlagEnabled({ experimentalFlags: undefined }, "contextualTranslation")).toBe(false)
  })

  it("a default-off flag still honours an explicit opt-in", () => {
    // Someone who deliberately switched Autopilot on keeps it across the
    // default flip — the stored value wins.
    expect(
      isFlagEnabled({ experimentalFlags: { contextualTranslation: true } }, "contextualTranslation"),
    ).toBe(true)
  })

  it("stored value wins over the default", () => {
    expect(
      isFlagEnabled({ experimentalFlags: { contextualTranslation: true } }, "contextualTranslation"),
    ).toBe(true)
    expect(
      isFlagEnabled({ experimentalFlags: { contextualTranslation: false } }, "contextualTranslation"),
    ).toBe(false)
  })

  it("a default-on flag reads true when the record has no entry", () => {
    FLAGS.__testDefaultOn = {
      labelKey: "autopilot.settings.controlsLabel",
      descriptionKey: "autopilot.settings.controlsDescription",
      default: true,
    }
    expect(isFlagEnabled({}, "__testDefaultOn")).toBe(true)
    expect(isFlagEnabled({ experimentalFlags: { __testDefaultOn: false } }, "__testDefaultOn")).toBe(false)
  })

  it("unknown keys are ignored on read — always false, even when stored", () => {
    expect(isFlagEnabled({}, "noSuchFlag")).toBe(false)
    expect(isFlagEnabled({ experimentalFlags: { noSuchFlag: true } }, "noSuchFlag")).toBe(false)
  })

  it("stray unknown keys in the record do not affect known flags", () => {
    expect(
      isFlagEnabled(
        { experimentalFlags: { retiredFlag: true, contextualTranslation: true } },
        "contextualTranslation",
      ),
    ).toBe(true)
  })
})
