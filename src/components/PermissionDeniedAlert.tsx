import { useMemo } from "react"
import { BookOpen, ExternalLink } from "lucide-react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useAccounts } from "@/hooks/useAccounts"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

// AQU-623: link denials to the docs page describing permission levels, so a
// blocked user can learn what each role can do and how to get a higher one.
// Same build-time override + default convention as HelpMenu's DOCS_URL.
const PERMISSION_DOCS_URL =
  ((import.meta.env.VITE_DOCS_URL as string | undefined)?.trim() ||
    "https://help.aquilla.app") + "/permissions"

// AQU-560: a permission-denied message should name the account you're *currently*
// signed in as and give you a one-click way to switch users — a lot of denials
// are just "you're on the wrong account" (e.g. signed in as the translator when
// you meant your owner account). Extracted from the ProjectSettings shared-settings
// alert (AQU-427) so any permission-gated surface can reuse the same affordance.

export interface PermissionDeniedAlertProps {
  /**
   * What the active account was blocked from doing, woven into the sentence:
   * "…doesn't have permission to {action}". Use a bare verb phrase, e.g.
   * "change shared settings" or "add members to this project".
   */
  action: string
  /**
   * Optional role requirement, rendered as "(needs {requiredRole})", e.g.
   * "Maintainer or higher".
   */
  requiredRole?: string
  /**
   * AQU-623 — the active account's current role on this project, as a display
   * label (e.g. "Viewer"). When provided, the alert speaks the permission
   * vocabulary — "…as a Viewer on this project, you can't {action}" — so the
   * user sees exactly which role they hold and why it's blocked. Omit on
   * surfaces where the caller's project role isn't resolved.
   */
  currentRole?: string
  className?: string
}

/**
 * Inline alert for a permission-denied action. Names the active account and
 * offers a direct account switch — either quick "Switch to X" buttons for
 * already-signed-in accounts, or the full AccountSwitcher to add/switch when
 * there's no other session.
 */
export function PermissionDeniedAlert({ action, requiredRole, currentRole, className }: PermissionDeniedAlertProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const { sessions, activate } = useAccounts()
  const otherSessions = useMemo(() => sessions.filter((s) => !s.active), [sessions])

  const account = `${session?.username ?? "local"}${session?.email ? ` (${session.email})` : ""}`
  const requiredRoleNote = requiredRole
    ? t("error.permissionDenied.requiredRoleNote", { requiredRole })
    : ""
  // AQU-511 wave-3 finding 4: the account name and the role are the two facts
  // this alert exists to convey — restore font-medium on both so they stay
  // visually distinct from the surrounding prose instead of flattening into
  // plain text, as they were before RichMessage.
  const accountNode = <span className="font-medium">{account}</span>

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col gap-2 rounded border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm",
        className,
      )}
    >
      <p className="text-destructive">
        {currentRole ? (
          <RichMessage
            k="error.permissionDenied.messageWithRole"
            values={{
              account: accountNode,
              role: <span className="font-medium">{currentRole}</span>,
              action,
              requiredRoleNote,
            }}
          />
        ) : (
          <RichMessage
            k="error.permissionDenied.messageWithoutRole"
            values={{ account: accountNode, action, requiredRoleNote }}
          />
        )}
      </p>
      <a
        href={PERMISSION_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        <BookOpen className="h-3.5 w-3.5" aria-hidden />
        {t("error.permissionDenied.learnMore")}
        <ExternalLink className="h-3 w-3 opacity-60" aria-hidden />
      </a>
      {otherSessions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("error.permissionDenied.switchAccountLabel")}</span>
          {otherSessions.map((s) => (
            <Button
              key={s.key}
              size="sm"
              variant="outline"
              onClick={() => activate(s.key)}
            >
              {t("error.permissionDenied.switchToAccount", { username: s.username })}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("error.permissionDenied.addOrSwitchLabel")}
          </span>
          <AccountSwitcher variant="header" />
        </div>
      )}
    </div>
  )
}
