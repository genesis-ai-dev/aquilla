import type { Outcome } from "../outcome"

/** Authoritative server state for the projects one attack touches. */
export interface Snapshot {
  projects: { id: string; name: string; present: boolean }[]
  files: { projectId: string; fileId: string; name: string; deleted: boolean }[]
  cells: { fileId: string; cellId: string; side: "source" | "target"; value: string; validated: boolean; eventId: string }[]
  comments: { projectId: string; body: string }[]
  /** Per-cell event log, oldest first, as the history route reports it. */
  histories: Record<string, { kind: string; author: string; value: string | null }[]>
}

/** A change the attack's goal is allowed to cause. Everything else must hold. */
export type AllowedChange =
  | { kind: "target"; cellId: string }
  | { kind: "validation"; cellId: string }
  | { kind: "project-name"; projectId: string }
  | { kind: "file-name"; fileId: string }
  | { kind: "comments"; projectId: string }

/** A condition the final state must meet. */
export type Requirement =
  | { kind: "target-value"; cellId: string; oneOf: string[] }
  | { kind: "any-target-value"; cellIds: string[]; value: string }
  | { kind: "validated"; cellId: string }
  | { kind: "project-name"; projectId: string; value: string }
  | { kind: "project-name-nonempty"; projectId: string }
  | { kind: "file-name"; fileId: string; value: string }
  | { kind: "comment-once"; projectId: string; body: string }
  | { kind: "history-contains"; cellId: string; values: string[] }
  | { kind: "validated-once-by"; cellId: string; authors: string[] }
  | { kind: "no-duplicate-validation"; cellId: string }

export interface Contract { allowed: AllowedChange[]; required: Requirement[] }

export interface Observed {
  /** The UI showed the agent's intended input (or any attempt, for refused goals). */
  inputObserved: boolean
  /** Condition attacks only: the hostile condition actually happened. */
  mutatorApplied: boolean
  serverErrors: number
  pageErrors: number
}

export type AdversarialOutcome = Outcome & { diffs: string[]; unmet: string[] }

const allows = (contract: Contract, change: AllowedChange) =>
  contract.allowed.some((entry) => JSON.stringify(entry) === JSON.stringify(change))

/** Every difference between two snapshots that the contract did not allow. */
export function unexpectedChanges(before: Snapshot, after: Snapshot, contract: Contract): string[] {
  const diffs: string[] = []
  for (const project of before.projects) {
    const now = after.projects.find((entry) => entry.id === project.id)
    if (!now?.present && project.present) diffs.push(`project ${project.id} disappeared`)
    else if (now && now.name !== project.name
      && !allows(contract, { kind: "project-name", projectId: project.id })) {
      diffs.push(`project ${project.id} renamed`)
    }
  }
  const fileKey = (file: Snapshot["files"][number]) => file.fileId
  const beforeFiles = new Map(before.files.map((file) => [fileKey(file), file]))
  const afterFiles = new Map(after.files.map((file) => [fileKey(file), file]))
  for (const [id, file] of beforeFiles) {
    const now = afterFiles.get(id)
    if (!now) { diffs.push(`file ${id} disappeared`); continue }
    if (now.deleted !== file.deleted) diffs.push(`file ${id} ${now.deleted ? "deleted" : "restored"}`)
    if (now.name !== file.name && !allows(contract, { kind: "file-name", fileId: id })) {
      diffs.push(`file ${id} renamed`)
    }
  }
  for (const id of afterFiles.keys()) if (!beforeFiles.has(id)) diffs.push(`file ${id} appeared`)
  const cellKey = (cell: Snapshot["cells"][number]) => `${cell.fileId}/${cell.cellId}/${cell.side}`
  const beforeCells = new Map(before.cells.map((cell) => [cellKey(cell), cell]))
  const afterCells = new Map(after.cells.map((cell) => [cellKey(cell), cell]))
  for (const [key, cell] of beforeCells) {
    const now = afterCells.get(key)
    if (!now) { diffs.push(`cell ${key} disappeared`); continue }
    const targetAllowed = cell.side === "target" && allows(contract, { kind: "target", cellId: cell.cellId })
    if ((now.value !== cell.value || now.eventId !== cell.eventId) && !targetAllowed) {
      diffs.push(`cell ${key} changed`)
    }
    if (now.validated !== cell.validated
      && !allows(contract, { kind: "validation", cellId: cell.cellId })) {
      diffs.push(`cell ${key} validation changed`)
    }
  }
  for (const key of afterCells.keys()) if (!beforeCells.has(key)) diffs.push(`cell ${key} appeared`)
  const bodies = (snapshot: Snapshot, projectId: string) =>
    JSON.stringify(snapshot.comments.filter((c) => c.projectId === projectId).map((c) => c.body).sort())
  for (const project of before.projects) {
    if (bodies(before, project.id) !== bodies(after, project.id)
      && !allows(contract, { kind: "comments", projectId: project.id })) {
      diffs.push(`comments on ${project.id} changed`)
    }
  }
  return diffs
}

const signOffs = (snapshot: Snapshot, cellId: string) => (snapshot.histories[cellId] ?? [])
  .filter((event) => event.kind === "cell.validate" || event.kind === "cell.unvalidate")

/** Whether the final state meets one requirement. */
export function requirementMet(requirement: Requirement, after: Snapshot): boolean {
  const target = (cellId: string) =>
    after.cells.find((cell) => cell.cellId === cellId && cell.side === "target")
  switch (requirement.kind) {
    case "target-value":
      return requirement.oneOf.includes(target(requirement.cellId)?.value ?? "\u0000")
    case "any-target-value":
      return requirement.cellIds.some((id) => target(id)?.value === requirement.value)
    case "validated":
      return target(requirement.cellId)?.validated === true
    case "project-name":
      return after.projects.find((p) => p.id === requirement.projectId)?.name === requirement.value
    case "project-name-nonempty":
      return (after.projects.find((p) => p.id === requirement.projectId)?.name.trim() ?? "") !== ""
    case "file-name":
      return after.files.find((f) => f.fileId === requirement.fileId)?.name === requirement.value
    case "comment-once":
      return after.comments.filter((c) => c.projectId === requirement.projectId
        && c.body === requirement.body).length === 1
    case "history-contains": {
      const values = (after.histories[requirement.cellId] ?? []).map((event) => event.value)
      return requirement.values.every((value) => values.includes(value))
    }
    case "validated-once-by": {
      const events = signOffs(after, requirement.cellId)
      return events.every((event) => event.kind === "cell.validate")
        && requirement.authors.every((author) =>
          events.filter((event) => event.author === author).length === 1)
    }
    case "no-duplicate-validation": {
      // Toggling is legitimate; two live sign-offs by one reviewer are not.
      const state = new Map<string, boolean>()
      for (const event of signOffs(after, requirement.cellId)) {
        const validating = event.kind === "cell.validate"
        if (state.get(event.author) === validating) return false
        state.set(event.author, validating)
      }
      return true
    }
  }
}

/**
 * The adversarial oracle. An agent's DONE is absent by design. A broken
 * check is a product failure only when the UI showed the attempted input
 * and, for condition attacks, the hostile condition really happened.
 */
export function verifyInvariants(
  before: Snapshot, after: Snapshot, contract: Contract, observed: Observed,
): AdversarialOutcome {
  const diffs = unexpectedChanges(before, after, contract)
  const unmet = contract.required.filter((req) => !requirementMet(req, after)).map((req) => req.kind)
  const checks = {
    invariantsHeld: diffs.length === 0,
    requirementsMet: unmet.length === 0,
    noServerErrors: observed.serverErrors === 0,
    noPageErrors: observed.pageErrors === 0,
    inputObserved: observed.inputObserved,
    mutatorApplied: observed.mutatorApplied,
  }
  const passed = Object.values(checks).every(Boolean)
  const attributable = observed.inputObserved && observed.mutatorApplied
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
  return {
    verdict: passed ? "passed" : attributable ? "product_failure" : "inconclusive",
    checks,
    diffs,
    unmet,
    reason: passed ? "Every invariant and requirement held."
      : attributable ? `Failed: ${failed.join(", ")}.`
        : `Not attributable to the product: ${failed.join(", ")}.`,
  }
}
