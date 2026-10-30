/**
 * Opening another language before undoing a step made in it (decision 11,
 * gap 24). The workspace owns the language and knows when its lines and takes
 * have loaded; this is the part that can be tested without it.
 */
import type { LaneSwitch } from "./history"

export interface LaneAccess {
  /** Every language the project has (the switcher's list). */
  available: readonly string[]
  /** Languages the person was limited to, or null when not limited. */
  scoped: readonly string[] | null
  /** Languages that are archived (frozen). */
  archived: readonly string[] | undefined
  /** Whether this person may use the language switcher at all. */
  canSwitch: boolean
  /** Whether the project's languages have loaded: until they have, the list
   *  above is a stand-in, and a language missing from it is not one the
   *  person lost (review, Oct 29). */
  loaded: boolean
}

/**
 * Whether a step's language can be opened for an undo: `denied` when the
 * person has lost it for good (it was removed, archived, or lies outside the
 * languages they were limited to), `blocked` when it is theirs but they cannot
 * switch to it from here (a contributor's language opens from their
 * assignment) or the languages have not loaded yet, else `ok`.
 */
export function laneAccessFor(lane: string, access: LaneAccess): "ok" | "denied" | "blocked" {
  if (!access.loaded) return "blocked"
  if (!access.available.includes(lane)) return "denied"
  if (access.archived?.includes(lane)) return "denied"
  if (access.scoped && access.scoped.length > 0) return access.scoped.includes(lane) ? "ok" : "denied"
  return access.canSwitch ? "ok" : "blocked"
}

/** What the workspace knows about the language on screen, for an undo waiting on it. */
export interface LaneShown {
  /** The language the switcher has open. */
  open: string
  /** The language the line store has sorted its rows for. It follows the
   *  switcher one effect pass later. */
  storeLane: string
  /** The open language's lines and takes have loaded. */
  loaded: boolean
}

/**
 * Whether `lane` is on screen with its lines and takes: its rows sorted for it
 * too, so loaded flags left over from the language before cannot count
 * (review, Oct 29).
 */
export function laneShownReady(lane: string, shown: LaneShown): boolean {
  return shown.open === lane && shown.storeLane === lane && shown.loaded
}

/**
 * Wait until `ready()` has held on two checks in a row — so the render that
 * made it true has also run its effects (the step handlers re-register there
 * with the new language) — or give up after `timeoutMs`.
 */
export function waitUntilReady(ready: () => boolean, timeoutMs = 15_000, everyMs = 60): Promise<LaneSwitch> {
  return new Promise((resolve) => {
    const started = Date.now()
    let seen = 0
    const check = () => {
      seen = ready() ? seen + 1 : 0
      if (seen >= 2) return resolve("ready")
      if (Date.now() - started >= timeoutMs) return resolve("blocked")
      setTimeout(check, everyMs)
    }
    setTimeout(check, everyMs)
  })
}
