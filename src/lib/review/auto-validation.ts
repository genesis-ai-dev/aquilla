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
