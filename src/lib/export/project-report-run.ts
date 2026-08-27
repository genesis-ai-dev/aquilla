// Gathering a whole project's health into one document. (AQU-646, 2026-08-19)
//
// `project-report.ts` is pure — it turns data into sections and sections into
// HTML, and knows nothing about the network. This is the other half: the walk
// over a project's files that collects what those builders need.
//
// WHY IT IS ITS OWN MODULE rather than a block inside ExportDialog. The dialog
// is already long, and this is the only export that is project-scoped: it reads
// every subtitle file, each one's hidden audio-cue sibling, that sibling's
// recordings, and the links between them — four reads per episode, in sequence
// so a fifteen-file project does not open sixty connections at once. Injected
// fetchers keep all of that testable without a server, the same way the audio
// exporters are.
//
// A FILE THAT FAILS TO READ IS REPORTED, NOT FATAL. Anna runs this to find out
// what is wrong; falling over on the first unreachable episode would be the
// least useful possible response to "one of these is broken".

import { buildCellData, type CellData } from "@/hooks/useCells"
import { mergeCellsWithAudio } from "@/hooks/useFileAudioAttachments"
import { buildCueLinkIndex, EMPTY_CUE_LINK_INDEX, type CueLink } from "@/lib/sync/cell-links-read"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { CharacterResolution, ProjectTtsSettings } from "@/lib/parsers/types"
import {
  buildFileSection,
  findNameVariants,
  type ProjectReportData,
  type ReportFileInput,
} from "./project-report"

/** What the walk needs to know about one file before it reads anything. */
export interface ReportFileRef {
  id: string
  name: string
  /** The hidden audio-cue sibling anchored to this file, when there is one. */
  siblingId?: string | null
  /** What that sibling's import recorded about drift. */
  timebase?: { fromFps?: string; toFps?: string; scale: number } | null
}

export interface RunProjectReportArgs {
  projectId: string
  projectName: string
  /** The SUBTITLE files to report on — siblings are followed, never listed. */
  files: readonly ReportFileRef[]
  settings: ProjectTtsSettings | undefined
  resolutions?: Record<string, CharacterResolution>
  /** A sync token for one file. Null means this file cannot be read. */
  getToken: (fileId: string) => Promise<string | null>
  fetchCells: (projectId: string, fileId: string, jwt: string) => Promise<CellRow[]>
  fetchAudio: (projectId: string, fileId: string, jwt: string) => Promise<{ cells: Record<string, CellAudioEntry> }>
  fetchLinks: (projectId: string, fileId: string, jwt: string) => Promise<{ links: CueLink[] }>
  onProgress?: (done: number, total: number, fileName: string) => void
}

export interface ProjectReportRun {
  data: ProjectReportData
  /** Files that could not be read, with the reason. Reported IN the document —
   *  an episode missing from a health report is worse than one marked
   *  unreadable, because absence looks like a clean bill. */
  unreadable: { fileName: string; reason: string }[]
}

/** Cell rows → the CellData shape every builder expects. Mirrors what
 *  `useAudioCueCells` does for the timeline; "local" and 1 are the same inert
 *  placeholders it passes, since nothing here reads authorship or validation. */
function toCells(rows: CellRow[], fileId: string): CellData[] {
  return rows.map((row) => buildCellData(row.cellId, row, undefined, fileId, "local", 1, undefined))
}

export async function runProjectReport(args: RunProjectReportArgs): Promise<ProjectReportRun> {
  const inputs: ReportFileInput[] = []
  const unreadable: { fileName: string; reason: string }[] = []
  let done = 0

  for (const file of args.files) {
    args.onProgress?.(done, args.files.length, file.name)
    try {
      const token = await args.getToken(file.id)
      if (!token) throw new Error("no access to this file")
      const textRows = await args.fetchCells(args.projectId, file.id, token)

      // The cues, and — the part that matters for progress — their recordings.
      // A raw cell read carries no attachments, so without the merge every
      // character would look entirely unrecorded.
      let cueCells: CellData[] = []
      if (file.siblingId) {
        const siblingToken = (await args.getToken(file.siblingId)) ?? token
        const cueRows = await args.fetchCells(args.projectId, file.siblingId, siblingToken)
        const audio = await args
          .fetchAudio(args.projectId, file.siblingId, siblingToken)
          .catch(() => ({ cells: {} as Record<string, CellAudioEntry> }))
        cueCells = mergeCellsWithAudio(
          toCells(cueRows, file.siblingId),
          new Map(Object.entries(audio.cells)),
        )
      }

      // One read covers both sides: the route returns every edge touching this
      // file, and the sibling's edges are exactly those.
      const links = await args
        .fetchLinks(args.projectId, file.id, token)
        .then((r) => buildCueLinkIndex(r.links))
        .catch(() => EMPTY_CUE_LINK_INDEX)

      inputs.push({
        fileId: file.id,
        fileName: file.name,
        textCells: toCells(textRows, file.id),
        cueCells,
        links,
        settings: args.settings,
        ...(args.resolutions ? { resolutions: args.resolutions } : {}),
        ...(file.timebase ? { timebase: file.timebase } : {}),
      })
    } catch (cause) {
      unreadable.push({
        fileName: file.name,
        reason: cause instanceof Error ? cause.message : String(cause),
      })
    }
    done += 1
    args.onProgress?.(done, args.files.length, file.name)
  }

  return {
    data: {
      projectName: args.projectName,
      files: inputs.map(buildFileSection),
      // Name variants are the one finding that only exists ACROSS episodes:
      // MARY in one and MARY MAGDALENE in the next is invisible inside either.
      nameVariants: findNameVariants(inputs),
    },
    unreadable,
  }
}
