// AQU-1526 — what linking an established project to an upstream will bring in.
//
// Linking is additive (AQU-1525): the mirror seeds the upstream's source files
// alongside whatever this project already holds, and a file sharing a name with
// an upstream file is allowed and simply appears twice. That is the right
// behaviour — the original keeps the team's translations and the mirrored copy
// arrives with empty targets — but it used to happen with no warning, so the
// first a Project Lead learned of it was a doubled file list. An established
// project has very often already imported some of the same material (that is
// usually *why* someone wants to link it), so the clash is the common case, not
// the edge one.
//
// This module answers the confirm step's three questions ahead of the link:
// which upstream, how many files arrive, and which of them collide by name. It
// warns; it never blocks. The decision (Matthew, 2026-10-01) is "add alongside
// and warn first" — do not refuse the link on a name clash, and do not merge
// into the existing file.
//
// Kept separate from LinkSourceSection so the Import dialog's "From another
// project" entry point (AQU-1527) shows the same preview rather than growing a
// second, divergent one.

import { fetchProject } from "./projects-read"
import type { ProjectFileSummary } from "./projects-read-types"

/**
 * AQU-1559: one row of the confirm step's file list — an upstream file the lead
 * can leave checked or uncheck.
 *
 * `id` is the UPSTREAM file id, which is what the link request carries and what
 * the mirror matches on: the selection has to follow the file itself, so that
 * renaming a picked file upstream keeps it linked and the new name still comes
 * through. `clashes` is this row's own answer to the same-name question the
 * warning asks, so the warning can list only the clashing files still checked.
 */
export interface LinkSourcePreviewFile {
  id: string
  name: string
  clashes: boolean
}

export interface LinkSourcePreview {
  /** The upstream project's display name, as the server knows it. */
  upstreamName: string
  /**
   * AQU-1559: every file in the upstream, in the upstream's own order — the
   * rows of the confirm step's checkbox list. Empty for an upstream with no
   * files, which is a linkable situation with no list to show.
   */
  files: LinkSourcePreviewFile[]
  /**
   * How many files the upstream holds — `files.length`, and so the M of the
   * "N of M files" the link ends up following. AQU-1559 made this the ceiling
   * rather than the promise: the sentence the confirm step prints counts the
   * files still CHECKED, which starts equal to this and falls as the lead
   * unchecks. Every non-deleted upstream file mirrors:
   * `file.create` is itself a lane-relevant kind for a `consumes: 'source'`
   * link (sync-worker `events/link-sync.ts` → `LANE_KINDS_SOURCE`), so even an
   * upstream file with no source cells yet arrives. This is therefore the
   * upstream's whole file list, which is what makes the stated count equal the
   * number that actually turns up after confirming.
   *
   * AQU-1528 added the chain case (`consumes: 'target'`) to the same flow, and
   * this count is right for it unchanged: `laneKindsFor('target')` is
   * `LANE_KINDS_SOURCE` plus the target-commit/validate kinds, so the file set
   * that mirrors is identical — the corpus choice decides what the mirrored
   * cells say, not how many files arrive.
   */
  fileCount: number
  /**
   * Upstream file names that collide with a file this project already has,
   * compared ignoring letter case, in the upstream's own order. Each of these
   * will appear twice after linking. Empty means no warning is shown.
   */
  clashingNames: string[]
}

/**
 * Case-insensitive name clash between an upstream's files and this project's.
 *
 * Case-insensitive because the collision users care about is the one they can
 * see: `MRK` and `mrk` read as the same file in the sidebar, and the server
 * treats neither as a duplicate (`files.id` is the key, not the name — see
 * `deterministicDownstreamFileId`), so both really would sit there side by
 * side.
 *
 * The upstream's spelling is what gets reported: that is the name the mirrored
 * copy will carry, so it is the one that will be on screen afterwards. Repeated
 * upstream spellings of the same name collapse to one entry — the warning lists
 * names, not rows.
 */
export function buildLinkSourcePreview(
  upstream: { name: string; files: readonly Pick<ProjectFileSummary, "id" | "name">[] },
  existingFiles: readonly Pick<ProjectFileSummary, "name">[],
): LinkSourcePreview {
  const existing = new Set(existingFiles.map((f) => f.name.toLowerCase()))
  const clashingNames: string[] = []
  const seen = new Set<string>()
  // AQU-1559: one row per upstream file, each carrying its own clash answer.
  // `clashingNames` stays the de-duplicated name list the warning prints — two
  // upstream files spelled the same way are two rows to check but one line of
  // warning — so both derive from this single pass.
  const files: LinkSourcePreviewFile[] = []
  for (const file of upstream.files) {
    const key = file.name.toLowerCase()
    const clashes = existing.has(key)
    files.push({ id: file.id, name: file.name, clashes })
    if (!clashes || seen.has(key)) continue
    seen.add(key)
    clashingNames.push(file.name)
  }
  return {
    upstreamName: upstream.name,
    files,
    fileCount: upstream.files.length,
    clashingNames,
  }
}

/**
 * Read both file lists and build the preview.
 *
 * Both sides come from the same endpoint (auth-worker `GET /api/v2/projects/:id`)
 * so the clash compares like with like. The upstream read is the one that can
 * fail in a way the user needs to see — the caller shows the failure and offers
 * a retry rather than rendering a count of zero, which would read as "an empty
 * upstream" and is a different, linkable situation.
 */
export async function loadLinkSourcePreview(
  jwt: string,
  projectId: string,
  upstreamProjectId: string,
  apiUrl?: string,
): Promise<LinkSourcePreview> {
  const [upstream, self] = await Promise.all([
    fetchProject(upstreamProjectId, jwt, apiUrl),
    fetchProject(projectId, jwt, apiUrl),
  ])
  return buildLinkSourcePreview(upstream, self.files)
}
