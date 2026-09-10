import { describe, it, expect, afterEach } from "vitest"
import { FLAGS, isFlagEnabled } from "./flags"

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
