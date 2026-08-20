import { describe, it, expect, afterEach } from "vitest"
import { FLAGS, isFlagEnabled } from "./flags"

describe("feature flags registry", () => {
  it("defines contextualTranslation, default on", () => {
    // The flag gates DISCOVERY (is the play button visible), not spend — a run
    // only starts when someone clicks it. Off-by-default made the feature
    // reachable only by someone who already knew to go looking for it.
    expect(FLAGS.contextualTranslation).toBeDefined()
    expect(FLAGS.contextualTranslation.default).toBe(true)
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
    expect(isFlagEnabled({}, "contextualTranslation")).toBe(true)
    expect(isFlagEnabled({ experimentalFlags: undefined }, "contextualTranslation")).toBe(true)
  })

  it("a default-on flag still honours an explicit opt-out", () => {
    expect(
      isFlagEnabled({ experimentalFlags: { contextualTranslation: false } }, "contextualTranslation"),
    ).toBe(false)
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
