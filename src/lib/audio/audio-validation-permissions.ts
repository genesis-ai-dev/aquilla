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
