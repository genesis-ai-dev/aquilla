// Whether a person has the Back-translation column open in the editor.
//
// It is each person's own choice, per project and per device (localStorage),
// like the Bible columns beside Source. Three answers:
//   "shown" / "hidden" — they chose, and that wins;
//   null               — they never chose, so the column follows the project:
//                        open when the project reads translations back live,
//                        closed otherwise.

export type BtColumnChoice = "shown" | "hidden"

export const BT_COLUMN_CHANGED_EVENT = "aquilla:bt-column"

export function btColumnStorageKey(projectId: string): string {
  return `aquilla:bt-column:${projectId}`
}

export function readBtColumnChoice(projectId: string | undefined | null): BtColumnChoice | null {
  if (!projectId) return null
  try {
    const raw = window.localStorage.getItem(btColumnStorageKey(projectId))
    return raw === "shown" || raw === "hidden" ? raw : null
  } catch {
    return null
  }
}

export function writeBtColumnChoice(projectId: string | undefined | null, choice: BtColumnChoice): void {
  if (!projectId) return
  try {
    window.localStorage.setItem(btColumnStorageKey(projectId), choice)
  } catch {
    // localStorage may be unavailable — the choice then lasts for this session.
  }
  try {
    window.dispatchEvent(new CustomEvent(BT_COLUMN_CHANGED_EVENT, { detail: { projectId } }))
  } catch {
    // no window (tests without a DOM)
  }
}

/** The column is open when the person chose so, or never chose and the project is live. */
export function resolveBtColumnShown(choice: BtColumnChoice | null, projectIsLive: boolean): boolean {
  return choice ? choice === "shown" : projectIsLive
}
