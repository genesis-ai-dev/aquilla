/**
 * What an import may do with a file's languages (AQU-249 / AQU-1596).
 *
 * A file's declared languages are import information. They can pre-fill a
 * question and they can warn when they disagree with the lane the rows landed
 * in. They never become that lane's language. An explicit answer may still
 * repair the project's source, and the project's target only when the import
 * landed in the former default lane.
 */

import { languagesEqual } from "./language-normalize"

export interface InferredImportLanguages {
  sourceLanguage?: string
  targetLanguage?: string
  /** The user confirmed this in the direction panel. A file header is not explicit. */
  explicit?: boolean
}

export interface ImportLanguageDecision {
  newSource: string
  newTarget: string
  shouldPatch: boolean
  /** The file's declared target disagrees with the lane it was imported into. */
  warns: boolean
}

export function importLanguageDecision(
  currentSource: string,
  currentTarget: string,
  inferred: InferredImportLanguages,
  options?: {
    /** Import landed in a lane other than the former default (`''`). */
    nonDefaultLane?: boolean
    /**
     * Language of that lane's row. The warning compares against this when it
     * is set, and against `currentTarget` when the row has none.
     */
    laneLanguage?: string
  },
): ImportLanguageDecision {
  const { explicit, sourceLanguage: inSrc, targetLanguage: inTgt } = inferred
  const declaredTarget = inTgt?.trim() || ""
  const compared = options?.laneLanguage?.trim() || currentTarget
  const warns = Boolean(
    !explicit && declaredTarget && compared && !languagesEqual(declaredTarget, compared),
  )

  let newSource: string
  let newTarget: string
  if (options?.nonDefaultLane) {
    // The project's target language names the former default lane. An import
    // into another lane must not rewrite it, and the file's declaration must
    // not become the lane's language either.
    newSource = explicit ? (inSrc?.trim() || currentSource) : currentSource
    newTarget = currentTarget
  } else if (explicit) {
    const targetBroken = currentTarget === "" || languagesEqual(currentTarget, currentSource)
    newSource = inSrc?.trim() || currentSource
    newTarget = targetBroken ? (inTgt?.trim() || currentTarget) : currentTarget
  } else {
    newSource = currentSource
    newTarget = currentTarget
  }

  const sourceDiffers = newSource !== currentSource
  const targetDiffers = newTarget !== currentTarget
  const resultDistinct = !languagesEqual(newSource, newTarget)
  const shouldPatch = (sourceDiffers || targetDiffers) && resultDistinct && !!(newSource || newTarget)

  return { newSource, newTarget, shouldPatch, warns }
}
