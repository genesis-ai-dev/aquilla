// @vitest-environment node
// AQU-1573: the settings registry's `referenceBibleVersions` entry, the first
// 'custom' kind. The registry restates the shape check because it must stay
// dependency-free; the parity case below keeps it from drifting from the
// lane-setting module every reader resolves the value with.
import { describe, expect, it } from "vitest"
import { referenceBibleSettingShapeProblem } from "../../src/lib/reference-bible/lane-setting"
import { settingsKeyDocLines, validateSettingsKeyValue } from "./project-settings-keys"

const KEY = "referenceBibleVersions"

describe("referenceBibleVersions in the settings registry", () => {
  it.each([
    [{ "": "arb-vandyck" }],
    [{ "": "arb-vandyck", en: "eng-kjv" }],
    [{ Arabic: "arb-vandyck" }],
    [["arb-vandyck"]],
    [[]],
    [{}],
    [null],
  ])("accepts %j", (value) => {
    expect(validateSettingsKeyValue(KEY, value)).toBeNull()
  })

  it("rejects a second Bible in the array form and says to use the lane map", () => {
    const problem = validateSettingsKeyValue(KEY, ["arb-vandyck", "eng-kjv"])
    expect(problem).toContain(`settings key "${KEY}"`)
    expect(problem).toContain("one Bible per lane")
    expect(problem).toContain("{ laneTag: versionId }")
  })

  it.each([["arb-vandyck"], [42], [true], [{ "": "" }], [{ "": 5 }], [[""]], [[7]]])("rejects %j", (value) => {
    expect(validateSettingsKeyValue(KEY, value)).toMatch(/expects \{ \[laneTag\]: versionId \} \| \[versionId\]/)
  })

  it("describe_command lists the key with its shape", () => {
    expect(settingsKeyDocLines()).toContain(`${KEY}: { [laneTag]: versionId } | [versionId]`)
  })

  it("agrees with the lane-setting reader on every shape", () => {
    const samples: unknown[] = [
      { "": "arb-vandyck" }, { en: "eng-kjv", "": "arb-vandyck" }, ["arb-vandyck"], [], {},
      ["a", "b"], "arb-vandyck", 42, true, { "": "" }, { "": "  " }, { "": 5 }, [""], [7], [null],
      { en: null },
    ]
    for (const value of samples) {
      const registryOk = validateSettingsKeyValue(KEY, value) === null
      const readerOk = referenceBibleSettingShapeProblem(value) === null
      expect({ value, ok: registryOk }).toEqual({ value, ok: readerOk })
    }
  })

  it("leaves the other kinds' messages unchanged", () => {
    expect(validateSettingsKeyValue("targetLanes", "es")).toBe('settings key "targetLanes" expects string[]')
    expect(validateSettingsKeyValue("nope", 1)).toContain('unknown settings key "nope"')
  })
})
