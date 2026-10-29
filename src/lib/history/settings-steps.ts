/**
 * History steps for the project settings that do not live in the shared
 * settings: the project's name and the settings kept only on one device.
 * (AQU-2262; the shared ones are "settings.project", edit-steps.ts.)
 *
 * NAME. Renaming the project is one step. Undo gives it back its old name
 * while it still has the name the change gave it; a name someone gave it
 * since is kept.
 *
 * ONLY ON THIS DEVICE. Audio loading, Git auto-sync and the Health settings
 * are kept in this browser's copy of the project. The history follows the
 * person to every device, but these values do not: a step names the browser
 * it was made in, and only that browser can take it back. Another device says
 * so and leaves its own value alone. AI keys are never recorded at all — a
 * step is saved to the server, and a key never leaves the browser.
 */
import type { StepHandler, StepOutcome } from "./history"

const DONE: StepOutcome = { kind: "done" }
const GONE: StepOutcome = { kind: "skipped", reason: "gone" }
const CHANGED: StepOutcome = { kind: "skipped", reason: "changed" }
const OTHER_DEVICE: StepOutcome = { kind: "skipped", reason: "otherDevice" }

export interface ProjectNameData { before: string; after: string }
export interface DeviceSettingData { browser: string; key: string; before?: unknown; after?: unknown }

export interface SettingsStepContext {
  /** The project's name now, or null when the project is gone. */
  readName(): Promise<string | null>
  rename(name: string): Promise<void>
  /** This device's value for a setting (null when unset); undefined when the
   *  project is gone. */
  readDevice(key: string): Promise<unknown>
  writeDevice(key: string, value: unknown): Promise<void>
  /** This browser's name in a device step. */
  browser(): string
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function settingsStepHandlers(ctx: SettingsStepContext): Record<string, StepHandler<never>> {
  const nameFlip = async (_d: ProjectNameData, from: string, to: string): Promise<StepOutcome> => {
    const now = await ctx.readName()
    if (now == null) return GONE
    if (now !== from) return CHANGED
    await ctx.rename(to)
    return DONE
  }
  const deviceFlip = async (d: DeviceSettingData, from: unknown, to: unknown): Promise<StepOutcome> => {
    if (d.browser !== ctx.browser()) return OTHER_DEVICE
    const now = await ctx.readDevice(d.key)
    if (now === undefined) return GONE
    if (!sameValue(now, from)) return CHANGED
    await ctx.writeDevice(d.key, to)
    return DONE
  }
  return {
    "settings.projectName": {
      undo: (d: ProjectNameData) => nameFlip(d, d.after, d.before),
      redo: (d: ProjectNameData) => nameFlip(d, d.before, d.after),
    } as StepHandler<never>,
    "settings.device": {
      undo: (d: DeviceSettingData) => deviceFlip(d, d.after, d.before),
      redo: (d: DeviceSettingData) => deviceFlip(d, d.before, d.after),
    } as StepHandler<never>,
  }
}

const BROWSER_KEY = "aquilla.settings.browser"
let browserId: string | null = null

/**
 * This browser's name in a device step: kept in localStorage, so every tab of
 * this browser (which share its copy of the project) answers to it.
 */
export function thisBrowser(): string {
  if (browserId) return browserId
  try {
    const saved = globalThis.localStorage?.getItem(BROWSER_KEY)
    if (saved) return (browserId = saved)
  } catch {
    // unavailable: a name for this page load is still right for its steps
  }
  const minted = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  try {
    globalThis.localStorage?.setItem(BROWSER_KEY, minted)
  } catch {
    // as above
  }
  return (browserId = minted)
}
