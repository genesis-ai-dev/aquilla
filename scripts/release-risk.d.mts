/** Areas that keep a PR off the automatic hourly line until `release:approved`. */
export const HOLDING_AREAS: Set<string>

/** Every area name, in the order they print. */
export const AREAS: string[]

/** Path-based risk classification of one PR's changed files. */
export interface FileClassification {
  /** Areas touched (events, offline-sync, auth, migration, infra, export, sync), in AREAS order. */
  areas: string[]
  /** True when any touched area is in HOLDING_AREAS. */
  pathHolds: boolean
}

export function classifyFiles(files: Iterable<string>): FileClassification

/** Area → name of the check run that, green on the PR head, lifts that area's hold. */
export const AREA_GATES: Record<string, string>

/** The holding areas of `areas` not cleared by a passed gate. */
export function holdingAreas(areas: string[], passedGates?: string[]): string[]

export const RISK_LABEL_PREFIX: string
export const APPROVED_LABEL: string

/** `risk:<area>` for each area. */
export function riskLabelsFor(areas: string[]): string[]
