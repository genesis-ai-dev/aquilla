// AQU-2262: every settings change is one Undo step. The shared ones reuse
// slice 13's "settings.project" kind; one field of the drafting settings goes
// back on its own; the project's name and this device's own settings have
// kinds of their own.
import { describe, it, expect, vi } from "vitest"
import { editStepHandlers, type EditStepContext } from "./edit-steps"
import { settingsStepHandlers, type SettingsStepContext } from "./settings-steps"
import { stepLabel } from "./step-label"
import type { StepHandler } from "./history"

const as = (h: Record<string, StepHandler<never>>) => h as unknown as Record<string, StepHandler<unknown>>

function shared(now: Record<string, unknown>) {
  const ctx = {
    readSettings: (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, now[k]])),
    writeSettings: vi.fn(async () => {}),
  } as unknown as EditStepContext
  return { ctx, h: as(editStepHandlers(ctx)) }
}

describe("one field of an object setting", () => {
  it("goes back on its own, merged into the rest, while it still holds what the change left", async () => {
    const { ctx, h } = shared({ draftingSettings: { temperature: 0.5, model: "gpt" } })
    const d = { changes: [{ key: "draftingSettings", field: "temperature", before: 0.3, after: 0.5 }] }
    expect(await h["settings.project"].undo(d)).toEqual({ kind: "done" })
    expect(ctx.writeSettings).toHaveBeenCalledWith({ draftingSettings: { temperature: 0.3 } }, { mergeKeys: ["draftingSettings"] })
  })

  it("is left alone when someone has changed that field since, whatever happened to the others", async () => {
    const { ctx, h } = shared({ draftingSettings: { temperature: 0.9, model: "other" } })
    const d = { changes: [{ key: "draftingSettings", field: "temperature", before: 0.3, after: 0.5 }] }
    expect(await h["settings.project"].undo(d)).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.writeSettings).not.toHaveBeenCalled()
  })

  it("a field nobody had set goes back to unset", async () => {
    const { ctx, h } = shared({ draftingSettings: { temperature: 0.5 } })
    const d = { changes: [{ key: "draftingSettings", field: "temperature", after: 0.5 }] }
    expect(await h["settings.project"].undo(d)).toEqual({ kind: "done" })
    expect(ctx.writeSettings).toHaveBeenCalledWith({ draftingSettings: { temperature: undefined } }, { mergeKeys: ["draftingSettings"] })
  })
})

function own(over: Partial<SettingsStepContext> = {}) {
  const state: { name: string | null; device: Record<string, unknown> } = { name: "Ruth (draft 2)", device: { audioMediaStrategy: "eager" } }
  const ctx: SettingsStepContext = {
    readName: async () => state.name,
    rename: vi.fn(async (name: string) => { state.name = name }),
    readDevice: async (key) => state.device[key],
    writeDevice: vi.fn(async (key, value) => { state.device[key] = value }),
    browser: () => "this-browser",
    ...over,
  }
  return { state, ctx, h: as(settingsStepHandlers(ctx)) }
}

describe("the project's name", () => {
  it("goes back while the project still has the name the change gave it", async () => {
    const { h, state } = own()
    const d = { before: "Ruth", after: "Ruth (draft 2)" }
    expect(await h["settings.projectName"].undo(d)).toEqual({ kind: "done" })
    expect(state.name).toBe("Ruth")
    expect(await h["settings.projectName"].redo(d)).toEqual({ kind: "done" })
    expect(state.name).toBe("Ruth (draft 2)")
  })

  it("keeps a name someone gave it since", async () => {
    const { h, ctx } = own({ readName: async () => "Ruth — final" })
    expect(await h["settings.projectName"].undo({ before: "Ruth", after: "Ruth (draft 2)" })).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.rename).not.toHaveBeenCalled()
  })
})

describe("a setting kept only on this device", () => {
  it("goes back on the device it was changed on", async () => {
    const { h, state } = own()
    const d = { browser: "this-browser", key: "audioMediaStrategy", before: "lazy", after: "eager" }
    expect(await h["settings.device"].undo(d)).toEqual({ kind: "done" })
    expect(state.device.audioMediaStrategy).toBe("lazy")
  })

  it("is not undone from another device, which has its own value", async () => {
    const { h, ctx } = own()
    const d = { browser: "another-browser", key: "audioMediaStrategy", before: "lazy", after: "eager" }
    expect(await h["settings.device"].undo(d)).toEqual({ kind: "skipped", reason: "otherDevice" })
    expect(ctx.writeDevice).not.toHaveBeenCalled()
  })

  it("keeps a value changed since on this device", async () => {
    const { h, state } = own()
    state.device.audioMediaStrategy = "stream"
    const d = { browser: "this-browser", key: "audioMediaStrategy", before: "lazy", after: "eager" }
    expect(await h["settings.device"].undo(d)).toEqual({ kind: "skipped", reason: "changed" })
  })
})

describe("a step's name", () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    key === "editor.history.stepChangeSetting" ? `Change: ${String(params?.setting)}` : key === "projectSettings.field.exportFloor" ? "Who can export" : key
  it("names the setting in the language shown now, not the one it was recorded in", () => {
    expect(
      stepLabel(t as never, {
        labelKey: "editor.history.stepChangeSetting",
        labelParams: { setting: "Qui peut exporter", settingKey: "projectSettings.field.exportFloor" },
      }),
    ).toBe("Change: Who can export")
  })
})

describe("a settings step's language", () => {
  it("belongs to none, so undoing it never opens another language first", async () => {
    const { stepLane } = await import("./step-lane")
    expect(stepLane("settings.projectName", {}, "es")).toBeUndefined()
    expect(stepLane("settings.device", {}, "es")).toBeUndefined()
  })
})
