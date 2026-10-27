/** A copy's sidebar name. The uploaded name is kept until it is already taken. */
export function disambiguateCopyName(
  name: string,
  existingNames: readonly string[],
  suffix: string,
): string {
  const taken = new Set(existingNames.map((entry) => entry.trim().toLowerCase()))
  if (!taken.has(name.trim().toLowerCase())) return name
  const candidate = `${name} (${suffix})`
  if (!taken.has(candidate.trim().toLowerCase())) return candidate
  let n = 2
  while (taken.has(`${candidate} ${n}`.trim().toLowerCase())) n += 1
  return `${candidate} ${n}`
}

export type SidebarReimportMode = "update" | "updated-copy" | "blank"

export interface SidebarReimportPlan {
  displayName: string
  /** Set when the upload goes through /import/reconcile instead of a new import. */
  reconcileFileId?: string
  fork: boolean
  sourceFileId?: string
  reviewChangedSource: boolean
  stripTargets: boolean
}

/** How one sidebar re-import choice maps onto the import commit. */
export function planSidebarReimport(input: {
  mode: SidebarReimportMode
  targetFileId: string
  uploadName: string
  existingNames: readonly string[]
  /** Already translated word placed in parentheses when the name collides. */
  suffix: string
  forkFileId: string
}): SidebarReimportPlan {
  if (input.mode === "blank") {
    return {
      displayName: disambiguateCopyName(input.uploadName, input.existingNames, input.suffix),
      fork: false,
      reviewChangedSource: false,
      stripTargets: true,
    }
  }
  if (input.mode === "updated-copy") {
    return {
      displayName: disambiguateCopyName(input.uploadName, input.existingNames, input.suffix),
      reconcileFileId: input.forkFileId,
      fork: true,
      sourceFileId: input.targetFileId,
      reviewChangedSource: true,
      stripTargets: true,
    }
  }
  return {
    displayName: input.uploadName,
    reconcileFileId: input.targetFileId,
    fork: false,
    reviewChangedSource: true,
    stripTargets: true,
  }
}
