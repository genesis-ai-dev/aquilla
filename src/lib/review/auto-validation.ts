import { canPerform } from "@/lib/sync/role-policy"

interface AutoValidationDecision {
  value: string
  canValidate: boolean
  allowSelfValidation?: boolean
  roleLevel: number | null
}

/**
 * A direct human target edit may auto-validate only when it has content, the
 * editor capability is present, the project permits validating one's own work,
 * and the current server role can perform the validation event.
 *
 * Keep this policy separate from the enqueue side effect so the security-
 * relevant negative case (`allowSelfValidation === false`) has fast regression
 * coverage in addition to the browser journey.
 */
export function shouldAutoValidateHumanEdit({
  value,
  canValidate,
  allowSelfValidation,
  roleLevel,
}: AutoValidationDecision): boolean {
  return Boolean(
    value.trim() &&
    canValidate &&
    allowSelfValidation !== false &&
    canPerform("cell.validate", roleLevel),
  )
}

interface FreshRecordingDecision {
  /** May this person validate audio ANYWHERE on the project: role floor and
   *  named-validator list, resolved by `audioValidationScope`. */
  scopeCanValidate: boolean
  allowSelfValidationAudio?: boolean
  roleLevel: number | null
}

/**
 * AQU-490: the audio twin of the edit rule above. Saving a fresh recording
 * validates it, exactly as a direct human edit validates the cell — Sam's
 * ruling: "the most directly understood by translators; if they don't want
 * it they can complain."
 *
 * Where it must NOT fire is decided by the CALL SITE, not here: only the
 * recorder's own save path calls this. A denoise mints a new take, the
 * transcription re-attaches the same one ~800ms later, generate-voice
 * attaches a TTS clip, attach-file imports the programme audio — every one
 * of those goes through emitCellAudioAttach and none of them is a person
 * saying "this is my take". Hooking the attach would have auto-validated all
 * of them.
 *
 * `allowSelfValidationAudio` is the AUDIO switch, read on its own. Reading
 * the text switch here would be the one thing Sam's separate-settings ruling
 * exists to prevent.
 */
export function shouldAutoValidateFreshRecording({
  scopeCanValidate,
  allowSelfValidationAudio,
  roleLevel,
}: FreshRecordingDecision): boolean {
  return Boolean(
    scopeCanValidate &&
    allowSelfValidationAudio !== false &&
    canPerform("cell.audio.validate", roleLevel),
  )
}
