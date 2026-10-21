// AQU-1969: how a Validate assignment's own-approval counts are read on the
// client — what is "left", whether audio has anything to say, and who is
// furthest behind. The counts themselves are the server's
// (auth-worker/src/services/assignment-validation.ts); these mirror its
// `validationLeft` / `compareValidationBehind` so a list the server sorted and
// one the client sorts agree.

import type {
  AssignmentKind,
  ValidationCounts,
  ValidationProgress,
} from "@/lib/sync/assignments"

/** Lines still owed: never negative, and never counting what is waiting. */
export function validationLeft(c: ValidationCounts): number {
  return Math.max(0, c.total - c.validated - c.waiting)
}

/** Lines owed across both media — what "furthest behind" is measured by. */
export function validationLeftOverall(v: ValidationProgress): number {
  return validationLeft(v.text) + validationLeft(v.audio)
}

/**
 * Does the scope have anything recorded to approve? A text-only project's
 * validator has every line "waiting on a recording", which is not news; the
 * audio line is shown once at least one line in scope has been recorded (or
 * the assignee already approved one).
 */
export function validationHasAudio(v: ValidationProgress): boolean {
  return v.audio.total > v.audio.waiting || v.audio.validated > 0
}

/** Is this row a validate assignment carrying its counts? */
export function isValidationRow<T extends { kind?: AssignmentKind; validation?: ValidationProgress }>(
  row: T,
): row is T & { validation: ValidationProgress } {
  return row.kind === "validate" && row.validation != null
}

/**
 * Furthest behind first: most lines left, then most changed since they
 * approved, then by name so equal rows keep a stable order.
 */
export function compareValidationBehind(
  a: { validation: ValidationProgress; username: string | null },
  b: { validation: ValidationProgress; username: string | null },
): number {
  const changed = (v: ValidationProgress) => v.text.changed + v.audio.changed
  return (
    validationLeftOverall(b.validation) - validationLeftOverall(a.validation) ||
    changed(b.validation) - changed(a.validation) ||
    (a.username ?? "").localeCompare(b.username ?? "")
  )
}
