// AQU-2259: the project list's ONE set of sort values, and the memory of the
// last one chosen.
//
// The project table on the org home (and the org Projects page) is sorted by
// clicking its column headers. Nothing saved that choice: the only code that
// ever wrote one was the old ProjectsList, which is no longer shown, so the
// list always opened on "Recently updated". It also had its own set of named
// views ("recent", "attention", "overdue", "least-translated") beside the
// table's ("recent", "attention", "least-translated", "most-progress",
// "name", "pm"). Now a sort is simply a column and a direction, saved on this
// device whenever someone clicks a header.

/** The table columns a person can sort by. */
export const PROJECT_SORT_COLUMNS = [
  "name",
  "org",
  "translated",
  "validated",
  "audio",
  "units",
  "pm",
  "status",
  "edited",
] as const
export type ProjectSortColumn = (typeof PROJECT_SORT_COLUMNS)[number]

export interface ProjectSort {
  column: ProjectSortColumn
  desc: boolean
}

/** "Recently updated": what the list opens on when nothing was chosen. */
export const DEFAULT_PROJECT_SORT: ProjectSort = { column: "edited", desc: true }

/** What the "Needs attention" status filter sorts by: the most urgent first. */
export const ATTENTION_PROJECT_SORT: ProjectSort = { column: "status", desc: true }

const STORAGE_KEY = "aq.project-list-sort.v1"
/** Where the old named views were kept; read once so a choice survives. */
const LEGACY_LENS_KEY = "org:all-projects:view"

const LEGACY_LENSES: Readonly<Record<string, ProjectSort>> = {
  recent: DEFAULT_PROJECT_SORT,
  attention: ATTENTION_PROJECT_SORT,
  overdue: ATTENTION_PROJECT_SORT,
  "least-translated": { column: "translated", desc: false },
  "most-progress": { column: "translated", desc: true },
  name: { column: "name", desc: false },
  pm: { column: "pm", desc: false },
}

function isSortColumn(value: unknown): value is ProjectSortColumn {
  return typeof value === "string" && (PROJECT_SORT_COLUMNS as readonly string[]).includes(value)
}

/** The sort the list should open on, on this device. Never throws. */
export function readProjectSort(): ProjectSort {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { column?: unknown; desc?: unknown }
      if (isSortColumn(parsed.column) && typeof parsed.desc === "boolean") {
        return { column: parsed.column, desc: parsed.desc }
      }
    }
    const legacy = localStorage.getItem(LEGACY_LENS_KEY)
    if (legacy && LEGACY_LENSES[legacy]) return LEGACY_LENSES[legacy]
  } catch {
    /* storage blocked or a malformed value: the default */
  }
  return DEFAULT_PROJECT_SORT
}

/** Remember the sort someone just chose. A column outside the set is ignored. */
export function writeProjectSort(sort: { column: string; desc: boolean }): void {
  if (!isSortColumn(sort.column)) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ column: sort.column, desc: sort.desc }))
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}
