// Translation Notes sidebar (AQU-179)
//
// Shows all TN rows matching the currently focused cell's canonicalRef.
// Reads from the server's cells-read route for every "tsv"-typed file in the
// project (those are TN imports — other TSV files could be CSV-bilingual but
// the canonicalRef filter ensures only bible-ref anchored notes surface).
//
// Persistence choice: no new DB table or migration. We reuse the existing
// cells projection + canonical_ref column. The sidebar fetches cells from the
// server filtered client-side by canonicalRef. This is consistent with the
// architecture and requires zero new server endpoints.
//
// SWARM-TODO(tn-sidebar-click-path):
//   Import → Translation Notes card → upload fixture → open biblical file →
//   focus a cell at GEN 1:1 → sidebar slides in showing all TN rows for GEN 1:1.
//   Multiple TN files separated by thin divider with file name header.
//   Hidden by default; enabled via "Show translation notes" in the View
//   settings menu (or the X in the sidebar header). Preference persisted in
//   localStorage scoped to (projectId).

import { useEffect, useState, useCallback } from "react"
import { fetchProjectFiles, fetchFileCells } from "@/lib/sync/cells-read"
import { cn } from "@/lib/utils"
import { BookOpen, X } from "lucide-react"

// Sentinel fileId for project-scoped token mints (no specific file).
// Must match the "__project__" sentinel used by useComments,
// and the sync-worker's authorize.ts — the auth-worker accepts any fileId
// string but verifyTokenForProject only checks the projectId claim, so any
// value works for read-only project-scoped routes.  Using the established
// sentinel keeps the pattern consistent and future-proof.
const PROJECT_SENTINEL_FILE_ID = "__project__"

export interface TnNote {
  /** Source file name */
  fileName: string
  fileId: string
  /** TN row content (may include Markdown) */
  body: string
  /**
   * AQU-527: the original-language phrase (Greek/Hebrew) this note is about,
   * from the imported cell's `metadata.tnQuote`. UW's #1 requirement — shown
   * above the note body so translators aren't "editing blind." Absent for
   * general notes with no phrase anchor, or for TN files imported before this
   * change (re-import to backfill).
   */
  quote?: string
  /** Row index within the file, for stable ordering */
  rowIndex: number
}

/** Read the original-language phrase off a cell's extensible metadata bucket. */
function readTnQuote(metadata: Record<string, unknown> | null | undefined): string | undefined {
  if (!metadata) return undefined
  const q = metadata.tnQuote
  return typeof q === "string" && q.trim().length > 0 ? q : undefined
}

interface TranslationNotesSidebarProps {
  projectId: string
  canonicalRef: string | null
  getToken: (fileId: string) => Promise<string | null>
  /** When false the sidebar is hidden. Controlled by parent (ProjectWorkspace). */
  visible: boolean
  onToggle: () => void
  className?: string
}

const STORAGE_KEY_PREFIX = "codex:tn-sidebar:"

function sidebarVisibilityKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}:visible`
}

export function readTnSidebarVisible(projectId: string): boolean {
  // Hidden by default — opt in via the View settings menu.
  try {
    const v = window.localStorage.getItem(sidebarVisibilityKey(projectId))
    return v === "true"
  } catch {
    return false
  }
}

export function writeTnSidebarVisible(projectId: string, value: boolean): void {
  try {
    window.localStorage.setItem(sidebarVisibilityKey(projectId), value ? "true" : "false")
  } catch {
    // localStorage may be unavailable — ignore
  }
}

export function TranslationNotesSidebar({
  projectId,
  canonicalRef,
  getToken,
  visible,
  onToggle,
  className,
}: TranslationNotesSidebarProps) {
  const [notes, setNotes] = useState<TnNote[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchNotes = useCallback(async (ref: string) => {
    setLoading(true)
    setError(null)
    try {
      // Get a project-scoped token to fetch the file list.  We use the
      // established "__project__" sentinel — the same one that useComments
      // and useComments use for project-level reads — so the minted JWT is
      // recognisably project-scoped rather than an arbitrary placeholder.
      const jwt = await getToken(PROJECT_SENTINEL_FILE_ID)
      if (!jwt) {
        setNotes([])
        return
      }

      // Fetch all files in the project, filter for TSV (TN imports).
      const allFiles = await fetchProjectFiles(projectId, jwt)
      const tnFiles = allFiles.filter((f) => f.fileType === "tsv")

      if (tnFiles.length === 0) {
        setNotes([])
        return
      }

      // Fetch source cells from each TN file and collect those matching the ref.
      const allNotes: TnNote[] = []
      for (const tnFile of tnFiles) {
        const fileJwt = await getToken(tnFile.fileId)
        if (!fileJwt) continue
        try {
          // Stream all pages of the file's source cells.
          let cursor: string | undefined = undefined
          let rowIndex = 0
          do {
            const page = await fetchFileCells(
              projectId,
              tnFile.fileId,
              { side: "source", limit: 2000, ...(cursor ? { cursor } : {}) },
              fileJwt,
            )
            for (const cell of page.cells) {
              if (cell.canonicalRef === ref) {
                allNotes.push({
                  fileName: tnFile.name,
                  fileId: tnFile.fileId,
                  body: cell.value,
                  quote: readTnQuote(cell.metadata),
                  rowIndex,
                })
              }
              rowIndex++
            }
            cursor = page.nextCursor ?? undefined
          } while (cursor)
        } catch {
          // Silently skip a file that fails — don't block other TN files.
        }
      }

      setNotes(allNotes)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load translation notes")
    } finally {
      setLoading(false)
    }
  }, [projectId, getToken])

  useEffect(() => {
    if (!visible || !canonicalRef) {
      setNotes([])
      setError(null)
      return
    }
    void fetchNotes(canonicalRef)
  }, [visible, canonicalRef, fetchNotes])

  if (!visible) {
    // Fully hidden — re-enabled via "Show translation notes" in the View
    // settings menu, not an always-present rail button.
    return null
  }

  // Group notes by file name so multiple TN files are separated visually.
  const byFile = new Map<string, { fileName: string; notes: TnNote[] }>()
  for (const note of notes) {
    if (!byFile.has(note.fileId)) {
      byFile.set(note.fileId, { fileName: note.fileName, notes: [] })
    }
    byFile.get(note.fileId)!.notes.push(note)
  }

  return (
    <div
      className={cn(
        "flex h-full w-72 flex-col border-l bg-background text-sm",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-1.5 font-medium">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <span>Translation Notes</span>
          {canonicalRef && (
            <span className="rounded bg-muted px-1 py-0.5 text-xs font-mono text-muted-foreground">
              {canonicalRef}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label="Hide translation notes"
          onClick={onToggle}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {!canonicalRef ? (
          <p className="p-4 text-xs text-muted-foreground">
            Focus a translation cell to see notes for that verse.
          </p>
        ) : loading ? (
          <p className="p-4 text-xs text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="p-4 text-xs text-destructive">{error}</p>
        ) : notes.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">
            No translation notes for <span className="font-mono">{canonicalRef}</span>.
          </p>
        ) : (
          <div className="divide-y">
            {[...byFile.values()].map(({ fileName, notes: fileNotes }) => (
              <div key={fileName}>
                {byFile.size > 1 && (
                  <div className="sticky top-0 bg-muted/60 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {fileName}
                  </div>
                )}
                {fileNotes.map((note, idx) => (
                  <NoteCard key={`${note.fileId}-${note.rowIndex}`} note={note} showDivider={idx > 0} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface NoteCardProps {
  note: TnNote
  showDivider: boolean
}

function NoteCard({ note, showDivider }: NoteCardProps) {
  return (
    <div className={cn("space-y-1.5 px-3 py-2.5", showDivider && "border-t border-dashed")}>
      {note.quote && (
        // AQU-527: the original Greek/Hebrew phrase, distinct from the note
        // body. `dir="auto"` so Hebrew renders right-to-left. `lang` is left
        // unset — the phrase's own Unicode drives shaping/direction.
        <p
          dir="auto"
          data-testid="tn-original-phrase"
          title="Original-language phrase"
          className="border-l-2 border-primary/40 bg-muted/50 px-2 py-1 text-sm font-medium leading-snug text-foreground"
        >
          {note.quote}
        </p>
      )}
      <p className="text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap">
        {note.body}
      </p>
    </div>
  )
}
