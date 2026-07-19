import { useMemo } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useAccounts } from "@/hooks/useAccounts"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

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
  className?: string
}

/**
 * Inline alert for a permission-denied action. Names the active account and
 * offers a direct account switch — either quick "Switch to X" buttons for
 * already-signed-in accounts, or the full AccountSwitcher to add/switch when
 * there's no other session.
 */
export function PermissionDeniedAlert({ action, requiredRole, className }: PermissionDeniedAlertProps) {
  const { session } = useFrontierSession()
  const { sessions, activate } = useAccounts()
  const otherSessions = useMemo(() => sessions.filter((s) => !s.active), [sessions])

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col gap-2 rounded border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm",
        className,
      )}
    >
      <p className="text-destructive">
        You're signed in as{" "}
        <span className="font-medium">{session?.username ?? "local"}</span>
        {session?.email ? ` (${session.email})` : ""}, which doesn't have permission to {action}
        {requiredRole ? ` (needs ${requiredRole})` : ""}.
      </p>
      {otherSessions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Switch account:</span>
          {otherSessions.map((s) => (
            <Button
              key={s.key}
              size="sm"
              variant="outline"
              onClick={() => activate(s.key)}
            >
              Switch to {s.username}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Have another account? Add or switch:
          </span>
          <AccountSwitcher variant="header" />
        </div>
      )}
    </div>
  )
}
