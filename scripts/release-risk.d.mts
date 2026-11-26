/** Areas that keep a PR off the automatic line until their gate is green or `release:approved`. */
export const HOLDING_AREAS: Set<string>

/** Every area name, in the order they print. */
export const AREAS: string[]

/** Path-based risk classification of one PR's changed files. */
export interface FileClassification {
  /** Areas touched (migration, infra, release-tooling, deps, events, offline-sync, auth, export, sync, ci), in AREAS order. */
  areas: string[]
  /** True when any touched area is in HOLDING_AREAS. */
  pathHolds: boolean
}

export function classifyFiles(files: Iterable<string>): FileClassification

/** Area → name of the check run that, green on the PR head, lifts that area's hold. */
export const AREA_GATES: Record<string, string>

/** Area → repository variable that must be `on` for that area's gate to count. */
export const GATE_SWITCHES: Record<string, string>

/** Whether a green run of `area`'s gate may lift the hold, given the environment. */
export function gateEnabled(area: string, env?: Record<string, string | undefined>): boolean

/** The holding areas of `areas` not cleared by a passed gate. */
export function holdingAreas(areas: string[], passedGates?: string[]): string[]

export const RISK_LABEL_PREFIX: string
export const APPROVED_LABEL: string

/** `risk:<area>` for each area. */
export function riskLabelsFor(areas: string[]): string[]
