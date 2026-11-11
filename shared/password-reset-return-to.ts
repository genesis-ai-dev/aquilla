import { orgInviteReturnTo } from "./org-invite-return-to"

/** Reset-specific destinations; never broaden invitation redirect authority. */
export function passwordResetReturnTo(value: unknown): string | undefined {
  return value === "/preferences/login-methods" ? value : orgInviteReturnTo(value)
}
