// One project-settings GET for every mounted consumer (AQU-2654).
//
// `useProjectSettings` is mounted several times on one page (useProject, the
// DCS badge, the upstream cursor, a settings route-modal over the workspace),
// and each instance reads the same row on mount, on the focus wave and when
// the browser comes back online. Each used to send its own GET, and each
// response was its own React commit. They now await one request; because every
// instance resumes from the same promise, their state updates land in one
// commit as well.
//
// Freshness, by what the read is for:
//
//   - `afterWrite` FOLLOWS A WRITE (the settings-updated event, an imperative
//     `refresh()`). It must not be answered by a request that started before
//     that write, so it joins only a request started in the same synchronous
//     turn (the event reaches every sibling instance in one dispatch) and
//     otherwise starts a new one, which later callers then join. It also drops
//     the kept answer below.
//   - `revalidate` is "bring me up to date" after time away (the focus wave,
//     back online). It joins a request in flight and never uses a kept answer:
//     what was read before the tab was hidden is exactly what it is refreshing.
//   - `mount` hydrates an instance that has nothing yet. It joins a request in
//     flight, and may take an answer another instance confirmed in the last
//     MOUNT_REUSE_MS. A project page mounts its settings consumers in stages
//     (a lazy chunk, a panel that renders once the project resolved), and each
//     late one re-read a row its siblings had read a second earlier. The window
//     is the one the focus wave already runs on (window-focus-revalidate's
//     MIN_INTERVAL_MS: one read per 5 s is as fresh as a return to the tab
//     gets). A write inside the window still reaches the late instance: every
//     writer announces itself with the settings-updated event (local `patch`,
//     `refreshAfterWrite`, and the workspace's relay of the project DO frame
//     for a remote writer), and that is an `afterWrite` read for every
//     mounted instance. A write no instance is mounted to hear still drops
//     the kept answer (project-settings-write-signal.ts).

import { registerSharedStateResetForTests } from "@/lib/request-coalescer"
import { fetchProjectSettingsResult, type ProjectSettingsResponse } from "./project-settings"
import { onProjectSettingsWrite } from "./project-settings-write-signal"

export type ProjectSettingsReadResult = Awaited<ReturnType<typeof fetchProjectSettingsResult>>

export type ProjectSettingsReadMode = "mount" | "revalidate" | "afterWrite"

/** How long a confirmed answer may hydrate a newly mounted instance. */
export const MOUNT_REUSE_MS = 5_000

interface InFlightRead {
  promise: Promise<ProjectSettingsReadResult>
  turn: number
}

// Counts writes this tab knows of. A read that was in flight across one may
// hold the row from before it, so its answer is not kept.
let knownWrites = 0

const inFlight = new Map<string, InFlightRead>()
const lastAnswer = new Map<string, { result: ProjectSettingsReadResult; at: number }>()

let turn = 0
let turnOpen = false

/** A number that is the same for every call made before the stack unwinds. */
function currentTurn(): number {
  if (!turnOpen) {
    turnOpen = true
    turn += 1
    queueMicrotask(() => {
      turnOpen = false
    })
  }
  return turn
}

export function readProjectSettingsShared(
  jwt: string,
  projectId: string,
  mode: ProjectSettingsReadMode,
): Promise<ProjectSettingsReadResult> {
  const key = `${jwt}\n${projectId}`
  const now = currentTurn()
  const existing = inFlight.get(key)
  if (mode === "afterWrite") {
    if (existing && existing.turn === now) return existing.promise
    lastAnswer.delete(key)
  } else {
    if (existing) return existing.promise
    if (mode === "mount") {
      const kept = lastAnswer.get(key)
      if (kept && Date.now() - kept.at < MOUNT_REUSE_MS) return Promise.resolve(kept.result)
    }
  }
  const writesAtStart = knownWrites
  const entry: InFlightRead = {
    turn: now,
    promise: fetchProjectSettingsResult(jwt, projectId).then(
      (result) => {
        if (inFlight.get(key) === entry) {
          inFlight.delete(key)
          // Only an answer the server gave is kept; a failed read is retried.
          if (result.ok && writesAtStart === knownWrites) lastAnswer.set(key, { result, at: Date.now() })
          else lastAnswer.delete(key)
        }
        return result
      },
      (err: unknown) => {
        if (inFlight.get(key) === entry) inFlight.delete(key)
        throw err
      },
    ),
  }
  inFlight.set(key, entry)
  return entry.promise
}

// A write landed, or is being sent. Whatever was read before it must not
// hydrate a later mount, whether or not an instance is mounted to re-read.
onProjectSettingsWrite((projectId) => {
  knownWrites += 1
  for (const key of Array.from(lastAnswer.keys())) {
    if (key.endsWith(`\n${projectId}`)) lastAnswer.delete(key)
  }
})

const serialized = new WeakMap<ProjectSettingsResponse, string>()

function serialize(response: ProjectSettingsResponse): string | null {
  const known = serialized.get(response)
  if (known !== undefined) return known
  try {
    const text = JSON.stringify(response)
    serialized.set(response, text)
    return text
  } catch {
    return null
  }
}

/**
 * Do two settings responses say the same thing? A revalidation that returns
 * what the hook already holds must not replace it: a new object with equal
 * content re-renders every consumer for nothing. The serialized form is kept
 * per response object, so N instances comparing one shared response pay for
 * it once.
 */
export function sameProjectSettingsResponse(
  a: ProjectSettingsResponse | null,
  b: ProjectSettingsResponse | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.version !== b.version || a.updatedAt !== b.updatedAt) return false
  const left = serialize(a)
  return left !== null && left === serialize(b)
}

registerSharedStateResetForTests(() => {
  inFlight.clear()
  lastAnswer.clear()
})
