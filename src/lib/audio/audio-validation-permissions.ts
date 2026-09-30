// AQU-490: turning a cell's audio into the takes the validation control draws,
// with the project's policy already applied.
//
// ONE adapter, because five surfaces mount that control — the gutter, the take
// block, the recorder's take list, the timeline chip and the voice panel — and
// each of them asking "may I validate this?" in its own words is how the five
// end up disagreeing. The server asks the same question again in route.ts and
// is the actual authority; this exists so the UI does not offer a vote that is
// about to be refused, and can say why.
import type { ProjectRecord } from "@/lib/parsers/types"
import type { AudioValidationTake } from "@/components/cell/AudioValidationControl"
import {
  selectedDubTakes,
  type AudioAttachmentOut,
  type CellAudioEntry,
} from "@/lib/sync/cell-audio-read-types"

const ROLE_FLOOR: Record<string, number> = {
  reviewer: 300,
  project_lead: 500,
  maintainer: 600,
}

/**
 * The shape every surface actually holds: a row of the editor's `CellData`,
 * whose attachments are keyed BY audio id rather than carrying one.
 *
 * Converting here rather than at five call sites keeps the difference between
 * the wire shape and the editor's shape in one place — and it is a real
 * difference, not a formality: the key is the id, so a converter that forgot
 * to put it back would produce takes the control could name but never vote on.
 */
export interface CellLikeAudio {
  // Deliberately permissive on nullability: the editor's CodexCellAttachment
  // spells an absent voice `undefined` and the wire's AudioAttachmentOut
  // spells it `null`, and both are valid inputs here. Narrowing to one would
  // force a cast at whichever call site held the other.
  attachments?: Record<string, {
    slot?: string
    label?: string | null
    voiceId?: string | null
    role?: "dub" | "source"
    validatorCount?: number
    validators?: string[]
    recordedBy?: string | null
  }>
  selectedBySlot?: Record<string, string>
  selectedAudioId?: string | null
  selectedGeneratedVoiceAudioId?: string | null
}

export function audioEntryFromCell(cell: CellLikeAudio | undefined): CellAudioEntry | undefined {
  if (!cell?.attachments) return undefined
  const attachments: Record<string, AudioAttachmentOut> = {}
  for (const [audioId, att] of Object.entries(cell.attachments)) {
    attachments[audioId] = {
      audioId,
      url: "",
      slot: att.slot ?? "recording",
      mimeType: null,
      voiceId: att.voiceId ?? null,
      referenceAudioId: null,
      durationMs: null,
      label: att.label ?? null,
      trimStartMs: null,
      trimEndMs: null,
      ...(att.role ? { role: att.role } : {}),
      ...(att.validatorCount != null ? { validatorCount: att.validatorCount } : {}),
      ...(att.validators ? { validators: att.validators } : {}),
      ...(att.recordedBy !== undefined ? { recordedBy: att.recordedBy } : {}),
    }
  }
  return {
    attachments,
    selectedBySlot: cell.selectedBySlot,
    selectedAudioId: cell.selectedAudioId ?? null,
    selectedGeneratedVoiceAudioId: cell.selectedGeneratedVoiceAudioId ?? null,
    audioTimings: {},
  }
}

export interface AudioValidationPolicy {
  /** The viewer's project role level, or null for a local/git project. */
  roleLevel: number | null
  username: string
}

export interface TakeBlock {
  /** May the viewer validate audio anywhere in this project? */
  canValidate: boolean
  /** Why not — a translated string, or null when they can. */
  reason: "role" | "allowlist" | null
}

/**
 * The project-wide half of the question: role floor, then the named-validator
 * allowlist. Neither depends on which take is being looked at, so it is
 * resolved once per project rather than once per take.
 */
export function audioValidationScope(
  project: Pick<ProjectRecord, "validationRoleFloorAudio" | "validationNamedUsersAudio">,
  policy: AudioValidationPolicy,
): TakeBlock {
  // A local or git project has no role ladder at all; everything is allowed,
  // exactly as it is for text.
  if (policy.roleLevel !== null) {
    const floorName = project.validationRoleFloorAudio
    const floor = floorName ? ROLE_FLOOR[floorName] : undefined
    if (floor !== undefined && policy.roleLevel < floor) {
      return { canValidate: false, reason: "role" }
    }
  }
  const allowlist = project.validationNamedUsersAudio
  if (allowlist && allowlist.length > 0 && !allowlist.includes(policy.username)) {
    return { canValidate: false, reason: "allowlist" }
  }
  return { canValidate: true, reason: null }
}

/**
 * May the viewer validate THIS take, given the project-wide answer?
 *
 * The extra question is self-validation, and it turns on who RECORDED the
 * take — not who last touched it. `recordedBy` is absent on takes whose attach
 * event is gone, and absent is UNKNOWN: it must never match the viewer, or
 * turning self-validation off would lock everybody out of exactly the oldest
 * recordings.
 */
export function canValidateTake(
  take: Pick<AudioAttachmentOut, "recordedBy">,
  project: Pick<ProjectRecord, "allowSelfValidationAudio">,
  scope: TakeBlock,
  username: string,
): { canValidate: boolean; reason: "role" | "allowlist" | "self" | null } {
  if (!scope.canValidate) return { canValidate: false, reason: scope.reason }
  if (project.allowSelfValidationAudio === false) {
    const recorder = take.recordedBy
    if (recorder != null && recorder !== "" && recorder === username) {
      return { canValidate: false, reason: "self" }
    }
  }
  return { canValidate: true, reason: null }
}

/**
 * The takes the control draws for one cell, policy applied.
 *
 * `reasonText` translates the refusal; callers pass their `t`. Returning the
 * reason as a tag rather than a string keeps this module free of i18n, which
 * is what lets it be tested as a pure function.
 */
export function audioValidationTakes(
  entry: CellAudioEntry | undefined,
  project: Pick<
    ProjectRecord,
    "validationRoleFloorAudio" | "validationNamedUsersAudio" | "allowSelfValidationAudio"
  >,
  policy: AudioValidationPolicy,
  reasonText: (reason: "role" | "allowlist" | "self") => string,
): AudioValidationTake[] {
  if (!entry) return []
  const scope = audioValidationScope(project, policy)
  return selectedDubTakes(entry).map((take) => {
    const verdict = canValidateTake(take, project, scope, policy.username)
    return {
      audioId: take.audioId,
      label: take.label ?? null,
      slot: take.slot,
      validatorCount: take.validatorCount ?? 0,
      validators: take.validators ?? [],
      isGenerated: Boolean(take.voiceId),
      canValidate: verdict.canValidate,
      ...(verdict.reason ? { blockedReason: reasonText(verdict.reason) } : {}),
    }
  })
}

/** Where a take a line's audio check stands for LIVES: the row's own cell, or
 *  the heard line (a cue in the audio-cue sibling) that performs the line. */
export interface TakeOwner {
  fileId: string
  cellId: string
}

export interface LineValidation {
  takes: AudioValidationTake[]
  /** audioId → the cell a vote on that take is cast against. */
  ownerOf: ReadonlyMap<string, TakeOwner>
}

type OwnedCell = CellLikeAudio & { id: string; fileId: string }

/**
 * The takes a LINE's audio check stands for, and where each one lives.
 *
 * In a dubbing file a subtitle line's recordings are not on it: they hang off
 * the heard lines that perform it — cues in the hidden audio-cue sibling. A
 * check that read the row alone therefore found nothing: every subtitle line
 * said "No audio to validate", and a vote cast on the heard line's take in the
 * Recording tab never showed on it (Sam, 2026-09-30). So a line's set is its
 * own selected takes plus, for every heard line performing it, that heard
 * line's selected take(s) — each named by what the heard line says (`nameOf`),
 * so the hover list can tell two parts of one line apart — and `ownerOf` says
 * which cell a vote on each goes to.
 *
 * A heard line nobody has recorded yet (a line split across two, one of them
 * done) joins the set as an UNRECORDED member. It can take no vote, and it
 * keeps the line from reading fully validated — a row must never read
 * validated while part of it is silent without saying so (the dubbing rule
 * of 2026-09-20).
 *
 * With no heard lines this is `audioValidationTakes` on the row, every
 * owner the row itself.
 */
export function lineValidationTakes<C extends OwnedCell>(
  cell: OwnedCell,
  heardLines: ReadonlyArray<{ cell: C; hasTake: boolean }> | null | undefined,
  project: Pick<
    ProjectRecord,
    "validationRoleFloorAudio" | "validationNamedUsersAudio" | "allowSelfValidationAudio"
  >,
  policy: AudioValidationPolicy,
  reasonText: (reason: "role" | "allowlist" | "self" | "unrecorded") => string,
  nameOf: (cue: C) => string,
): LineValidation {
  const takes: AudioValidationTake[] = []
  const ownerOf = new Map<string, TakeOwner>()
  const add = (owner: OwnedCell, take: AudioValidationTake) => {
    if (ownerOf.has(take.audioId)) return
    ownerOf.set(take.audioId, { fileId: owner.fileId, cellId: owner.id })
    takes.push(take)
  }
  for (const take of audioValidationTakes(audioEntryFromCell(cell), project, policy, reasonText)) {
    add(cell, take)
  }
  for (const { cell: cue, hasTake } of heardLines ?? []) {
    const name = nameOf(cue)
    if (!hasTake) {
      add(cue, {
        audioId: `unrecorded:${cue.id}`,
        label: name,
        slot: "recording",
        validatorCount: 0,
        validators: [],
        isGenerated: false,
        canValidate: false,
        blockedReason: reasonText("unrecorded"),
        unrecorded: true,
      })
      continue
    }
    const own = audioValidationTakes(audioEntryFromCell(cue), project, policy, reasonText)
    for (const take of own) {
      // A heard line with a take on more than one track: keep each take's own
      // name beside the words, or the two would read the same.
      const label = own.length > 1 && take.label ? `${name} · ${take.label}` : name
      add(cue, { ...take, label })
    }
  }
  return { takes, ownerOf }
}

/**
 * The refusal, as a sentence. Every surface needs the same three, so the
 * mapping lives here rather than in five lambdas that could drift apart.
 *
 * `role` and `allowlist` deliberately say the SAME thing. A project's
 * named-validator list is not the viewer's business — telling someone they
 * are missing from a list they cannot see invites them to go asking about it,
 * and the actionable half ("you cannot validate recordings here") is
 * identical either way.
 */
type BlockedKey =
  | "editor.audioValidation.ownRecordingTooltip"
  | "editor.audioValidation.unavailableTooltip"
  | "editor.audioValidation.partNotRecordedTooltip"

export function audioBlockedReason(
  // Narrowed to the two keys this uses rather than `(key: string) => string`:
  // the app's `t` is typed against the whole catalogue, and a parameter typed
  // as plain `string` is not something it can be passed to.
  t: (key: BlockedKey) => string,
): (reason: "role" | "allowlist" | "self" | "unrecorded") => string {
  return (reason) => reason === "self"
    ? t("editor.audioValidation.ownRecordingTooltip")
    : reason === "unrecorded"
      ? t("editor.audioValidation.partNotRecordedTooltip")
      : t("editor.audioValidation.unavailableTooltip")
}
