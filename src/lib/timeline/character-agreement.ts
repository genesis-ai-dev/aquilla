// When both character sheets are in, do they agree? (AQU-646, 2026-08-18)
//
// The client ships two character spreadsheets per episode, keyed to opposite
// sides of the same script: one to the subtitle rows, one to the heard lines.
// Either alone simply answers — a cell with its own character answers for
// itself, and one without resolves across the links (`cue-character.ts`).
//
// Both together are worth more than either, because they are INDEPENDENT
// opinions about the same question. Where they disagree, one of three things
// is true: a link is wrong, a sheet is wrong, or the two sheets spell a name
// differently. All three are worth a person's attention and none of them can
// be found any other way — five bad links in episode 101 were found exactly
// like this, by noticing that a heard line had been given two speakers.
//
// NOTHING HERE WRITES. It reports.

import type { CameraState } from "@/lib/sync/cells-read-types"
import type { CueLinkIndex } from "@/lib/sync/cell-links-read"
import type { CharacterResolution } from "@/lib/parsers/types"

/** The slice of a cell this needs; `CellData` satisfies it. */
export interface ComparableCell {
  id: string
  metadata?: Record<string, unknown> | null
  cameraState?: CameraState
  original?: string
}

export type DisagreementKind =
  /** The two sheets name different people. */
  | "character"
  /** Same person, different shot. */
  | "camera"
  /** Same person, spelled differently — a typo to fix in the source file. */
  | "naming"

/**
 * ONE ROW PER LINK, carrying every axis that disagrees — not one row per
 * disagreement.
 *
 * A line can differ about the speaker AND the shot (episode 101's "Good." is
 * SIMON-on against ANDREW-off). Splitting those into two rows means settling
 * the name and then watching a second row appear for the camera, which reads
 * like the fix did not take. One visit settles a line.
 */
export interface CharacterDisagreement {
  cueCellId: string
  textCellId: string
  /** The heard line, for a list a person can read. */
  heard: string
  /** Present when the sheets name different people, or spell one two ways. */
  name?: { kind: "character" | "naming"; subtitle: string; audio: string }
  /** Present when they disagree about the shot. */
  camera?: { subtitle: CameraState; audio: CameraState }
  /**
   * What the sheets AGREE about, for the axes not in dispute. (Sam,
   * 2026-08-18.) On a speaker dispute the agreed camera angle is a shortcut:
   * click the card, look at the film, see who the camera is on — and
   * conversely a camera dispute showing the agreed name lets you check the
   * named person against the picture. Not rigorous, just faster.
   */
  context?: { name?: string; camera?: CameraState }
  /** Axes of THIS link already settled, so a row that is half-decided can say
   *  so rather than looking untouched. */
  settled?: CharacterResolution
}

/**
 * A link somebody has settled. Nothing ever drops out of the drawer (Sam,
 * 2026-08-18) — it moves here, out of the way but still readable and still
 * reversible.
 *
 * `current` is read from the cells, which now agree; `rejected` comes from the
 * record, because after a resolution the losing answer exists nowhere else.
 */
export interface ResolvedRow {
  cueCellId: string
  textCellId: string
  heard: string
  name?: { chose: "subtitle" | "audio"; current: string; rejected: string }
  camera?: { chose: "subtitle" | "audio"; current: CameraState; rejected: CameraState }
  at: number
}

/** The key a resolution is filed under. Exported so the writer and the reader
 *  cannot drift apart on it. */
export const resolutionKey = (textCellId: string, cueCellId: string): string =>
  `${textCellId} ${cueCellId}`

const castNameOf = (cell: ComparableCell | undefined): string =>
  cell?.metadata && typeof cell.metadata.cast_name === "string" ? cell.metadata.cast_name : ""

/**
 * The comparable form of a name.
 *
 * MEASURED, NOT GUESSED. The two 101 sheets write the same 40 characters
 * differently as a matter of course: the subtitle sheet ends names with a full
 * stop ("ANDREW.") where the audio sheet does not, and the audio sheet
 * separates the angle with a non-breaking space. Comparing raw strings would
 * report all 637 rows as disagreeing and the feature would be useless on its
 * first run.
 */
const normalizeName = (raw: string): string =>
  raw
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .toUpperCase()

/** Looser still: everything but the letters and digits. Two names equal here
 *  but not above are the SAME name typed differently — `MALE VENDOR #1`
 *  against `MALEVENDOR #1`, which is a real typo in the client's episode 101
 *  files and exactly the kind of thing worth handing back to them. */
const nameFingerprint = (raw: string): string =>
  normalizeName(raw).replace(/[^A-Z0-9]/g, "")

/**
 * Which camera values count as an ANSWER, i.e. something able to contradict
 * another answer.
 *
 * `on` and `off` always do. `mixed` and `group` do not, by default: both mean
 * "several, or not one answer", and a subtitle row spanning three heard lines
 * is genuinely mixed while each of those lines is individually on or off.
 * Absence never does — a sheet with no camera column would otherwise
 * contradict every row of one that has it, which is a gap, not a finding.
 *
 * MEASURED. Without the `mixed` carve-out the real episode-101 pair reports
 * 189 camera disagreements, essentially all of them a coarse `mixed` on the
 * subtitle side against the precise state the audio sheet knows. Burying six
 * real findings under those would have made the feature worthless on its first
 * run.
 *
 * `strict` opens either carve-out back up (Sam, 2026-08-20), because the
 * judgement is the client's rather than ours: her sheets may well have a run
 * where `mixed` against `on` is a real error somebody should look at. It is
 * offered as two switches in the drawer, both off, so the default view stays
 * the six findings rather than the hundred and eighty-nine.
 */
export interface StrictCameraOptions {
  /** Treat `mixed` as a real answer that can contradict `on`/`off`/`group`. */
  mixed?: boolean
  /** Treat `group` as one. */
  group?: boolean
}

const isSpecific = (s: CameraState | undefined, strict?: StrictCameraOptions): boolean =>
  s === "on" ||
  s === "off" ||
  (s === "mixed" && strict?.mixed === true) ||
  (s === "group" && strict?.group === true)

export interface CompareCharacterSourcesArgs {
  /** The audio-cue cells. */
  cues: readonly ComparableCell[]
  /** The subtitle file's cells. */
  textCells: readonly ComparableCell[]
  links: CueLinkIndex
  /** What has already been decided, from the project settings blob. */
  resolutions?: Record<string, CharacterResolution>
  /** Opt-in strictness for the two vague camera values. Default: both off, so
   *  neither `mixed` nor `group` can contradict anything. */
  strictCamera?: StrictCameraOptions
}

export interface CharacterAgreement {
  /** Links still to settle. */
  open: CharacterDisagreement[]
  /** Links already settled, newest first. */
  resolved: ResolvedRow[]
  /**
   * Links whose subtitle row serves SEVERAL cues, so its one name and one
   * camera value cannot be right about all of them.
   *
   * Counted, never listed as work. Episode 101's "Good. Good." is a row
   * labelled ANDREW covering an Andrew line and a Simon line: the per-line
   * display is already correct, there is nothing to fix, and offering buttons
   * would invite writing one speaker's name over the other's. This is also
   * what makes resolving safe — every ACTIONABLE row is one row, one cue.
   */
  sharedRows: number
}

/**
 * Every link where the two sheets say different things. Pure; no I/O.
 *
 * Only links where BOTH sides carry a character of their own are compared —
 * with one sheet loaded there is nothing to disagree with, and reporting
 * "the audio sheet is silent here" for six hundred lines would bury the
 * handful that matter.
 */
export function compareCharacterSources({
  cues,
  textCells,
  links,
  resolutions,
  strictCamera,
}: CompareCharacterSourcesArgs): CharacterAgreement {
  const textById = new Map(textCells.map((c) => [c.id, c]))
  const open: CharacterDisagreement[] = []
  const resolved: ResolvedRow[] = []
  const seen = new Set<string>()
  let sharedRows = 0

  for (const cue of cues) {
    const cueName = castNameOf(cue)
    if (cueName === "") continue
    for (const textCellId of links.textForCue.get(cue.id) ?? []) {
      const text = textById.get(textCellId)
      const textName = castNameOf(text)
      if (textName === "") continue

      // Rows serving several cues are counted, not offered. See `sharedRows`.
      if ((links.cuesForText.get(textCellId) ?? []).length > 1) {
        sharedRows++
        continue
      }

      const sameName = normalizeName(cueName) === normalizeName(textName)
      const sameFingerprint = nameFingerprint(cueName) === nameFingerprint(textName)
      const nameKind: "character" | "naming" | null = !sameFingerprint
        ? "character"
        : !sameName
          ? "naming"
          : null
      // Both sides must actually HAVE a state, and both must count as an
      // answer under the current strictness. See `isSpecific`.
      const cameraDiffers =
        isSpecific(cue.cameraState, strictCamera) &&
        isSpecific(text?.cameraState, strictCamera) &&
        cue.cameraState !== text?.cameraState

      const key = resolutionKey(textCellId, cue.id)
      const record = resolutions?.[key]
      seen.add(key)

      if (nameKind === null && !cameraDiffers) {
        // Nothing open. Either it was always fine, or somebody settled it —
        // and only the record can tell those apart, which is the whole reason
        // it is kept.
        if (record) {
          // SELF-HEALING: a record whose rejected answer EQUALS the current
          // one says nothing — both buttons would show the same value. The
          // 2026-08-18 re-click bug wrote exactly such records (the winner
          // recorded as its own rejection, destroying the real loser), and
          // any that were written before the fix are quietly retired here
          // rather than rendered as a choice between a thing and itself.
          const name =
            record.name && record.name.rejected !== cueName
              ? { name: { chose: record.name.chose, current: cueName, rejected: record.name.rejected } }
              : {}
          const camera =
            record.camera && cue.cameraState && record.camera.rejected !== cue.cameraState
              ? {
                  camera: {
                    chose: record.camera.chose,
                    current: cue.cameraState,
                    rejected: record.camera.rejected,
                  },
                }
              : {}
          if ("name" in name || "camera" in camera) {
            resolved.push({
              cueCellId: cue.id,
              textCellId,
              heard: cue.original ?? "",
              ...name,
              ...camera,
              at: record.at,
            })
          }
        }
        continue
      }

      // The undisputed axes ride along as context. The cue's own values are
      // used — per heard line, so the more precise of the two.
      const context = {
        ...(nameKind === null ? { name: cueName } : {}),
        ...(!cameraDiffers && cue.cameraState ? { camera: cue.cameraState } : {}),
      }
      open.push({
        cueCellId: cue.id,
        textCellId,
        heard: cue.original ?? "",
        ...(nameKind ? { name: { kind: nameKind, subtitle: textName, audio: cueName } } : {}),
        ...(cameraDiffers
          ? { camera: { subtitle: text!.cameraState!, audio: cue.cameraState! } }
          : {}),
        ...(Object.keys(context).length ? { context } : {}),
        ...(record ? { settled: record } : {}),
      })
    }
  }

  // A different speaker is the one that can put a performer on the wrong line,
  // so it leads; a spelling difference is housekeeping and comes last.
  const rank = (d: CharacterDisagreement) =>
    d.name?.kind === "character" ? 0 : d.camera ? 1 : 2
  return {
    open: open.sort((a, b) => rank(a) - rank(b)),
    resolved: resolved.sort((a, b) => b.at - a.at),
    sharedRows,
  }
}
