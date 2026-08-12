import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useLocation } from "react-router-dom"
import { ChevronDown, LogIn, LogOut, UserPlus, Check, Settings2 } from "lucide-react"
import { useAccounts } from "@/hooks/useAccounts"
import { hydrateSessionEmails, logout as revokeServerSide } from "@/lib/frontier/auth"
import { clearSession, listAllSessionJwts, removeSession, sessionKey } from "@/lib/frontier/session-store"
import { clearAllLocalData } from "@/lib/store/project-index"
import { outboxPendingCount } from "@/lib/sync/outbox"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FrontierLoginForm } from "./git-import/FrontierLoginForm"
import { FrontierSignupForm } from "./git-import/FrontierSignupForm"
import { FrontierForgotPasswordForm } from "./git-import/FrontierForgotPasswordForm"
import { cn } from "@/lib/utils"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { useT } from "@/lib/i18n/I18nProvider"

type AuthMode = "login" | "signup" | "forgot"

function AuthDialogBody({
  isAdditional,
  onDone,
  returnTo,
}: {
  isAdditional: boolean
  onDone: () => void
  returnTo?: string
}) {
  const t = useT()
  const [mode, setMode] = useState<AuthMode>("login")
  const titles: Record<AuthMode, string> = {
    login: isAdditional ? t("nav.account.addTitle") : t("nav.account.loginTitle"),
    signup: t("nav.account.signupTitle"),
    forgot: t("auth.resetPassword.title"),
  }
  return (
    <>
      <DialogHeader><DialogTitle>{titles[mode]}</DialogTitle></DialogHeader>
      {mode === "login" && (
        <div className="space-y-4">
          <FrontierLoginForm
            onSuccess={onDone}
            onForgotPassword={() => setMode("forgot")}
            returnTo={returnTo}
          />
          <p className="text-center text-sm text-muted-foreground">
            {t("nav.account.newToFrontier")}{" "}
            <button
              type="button"
              onClick={() => setMode("signup")}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t("auth.login.createAccountLink")}
            </button>
          </p>
        </div>
      )}
      {mode === "signup" && (
        <div className="space-y-4">
          <FrontierSignupForm onSuccess={onDone} />
          <p className="text-center text-sm text-muted-foreground">
            {t("auth.join.alreadyHaveAccount")}{" "}
            <button
              type="button"
              onClick={() => setMode("login")}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t("common.logIn")}
            </button>
          </p>
        </div>
      )}
      {mode === "forgot" && (
        <FrontierForgotPasswordForm
          onBack={(rt) => { setMode("login"); if (rt) { /* returnTo stays in the login form via prop */ } }}
          returnTo={returnTo}
        />
      )}
    </>
  )
}

type LogoutScope = "single" | "all"

const ACCOUNT_MENU_ITEM_CLASS =
  "grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-0 gap-x-2 px-2 py-1.5"

export function AccountSwitcher({
  variant = "sidebar",
  compact = false,
}: { variant?: "sidebar" | "header"; compact?: boolean } = {}) {
  const t = useT()
  const { active, sessions, activate } = useAccounts()
  const qc = useQueryClient()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [pendingLogout, setPendingLogout] = useState<{ count: number; scope: LogoutScope } | null>(null)
  // Capture the destination before showing the login dialog so the user
  // returns to the same page after reset → login.
  const returnTo = location.pathname !== "/" ? location.pathname + location.search : undefined

  const isHeader = variant === "header"

  // JWTs don't carry email — backfill from /auth/me for every logged-in
  // account when the menu opens so each row can show its address.
  useEffect(() => {
    if (!open) return
    void hydrateSessionEmails().catch(() => {})
  }, [open])

  async function handleLogout(scope: LogoutScope) {
    setOpen(false)
    const count = await outboxPendingCount()
    if (count > 0) {
      setPendingLogout({ count, scope })
      return
    }
    await doLogout(scope)
  }

  // [Pen test] Auth & session mgmt (2026-08-03): this used to only drop
  // tokens client-side (clearSession/removeSession) — a stolen token kept
  // authenticating server-side for up to its full 30-day expiry. Denylist
  // server-side first, best-effort (revokeServerSide never throws, so a
  // network hiccup never blocks the local sign-out).
  async function doLogout(scope: LogoutScope) {
    if (scope === "all") {
      const jwts = await listAllSessionJwts()
      await Promise.all(jwts.map((jwt) => revokeServerSide(jwt)))
      await clearSession()
    } else if (active) {
      await revokeServerSide(active.jwt)
      await removeSession(sessionKey(active))
    }
    await clearAllLocalData()
    // Wipe in-memory query cache so the UI reflects the new auth state —
    // a still-signed-in account that was just promoted, or none at all —
    // rather than rendering the logged-out account's cached data.
    qc.clear()
  }

  if (!active) {
    return (
      <>
        <button
          className={cn(
            "flex items-center gap-2 rounded-xl bg-card text-sm transition-shadow",
            compact ? "h-8 w-8 justify-center p-0" : "px-2 py-1.5",
            !isHeader && !compact && "w-full",
            isHeader && "h-9",
          )}
          aria-label={t("common.logIn")}
          onClick={() => setLoginOpen(true)}
        >
          <LogIn className="h-4 w-4" />
          {!compact && <span>{t("common.logIn")}</span>}
        </button>
        <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
          <DialogContent className="max-w-sm">
            <AuthDialogBody isAdditional={false} onDone={() => setLoginOpen(false)} returnTo={returnTo} />
          </DialogContent>
        </Dialog>
      </>
    )
  }

  const menuContent = (
    <>
      <DropdownMenuGroup>
        {sessions.map((s) => (
          <AccountMenuEntry
            key={s.key}
            summary={s}
            onSelect={s.active ? undefined : () => { setOpen(false); activate(s.key) }}
          />
        ))}
      </DropdownMenuGroup>
      <DropdownMenuSeparator className="mx-0 my-1" />
      <DropdownMenuGroup>
        <DropdownMenuItem
          render={
            <Link
              to="/preferences"
              state={{ backgroundLocation: location, preferencesModalDepth: 1 }}
              onClick={() => setOpen(false)}
            />
          }
        >
          <Settings2 />
          {t("nav.account.preferences")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => { setOpen(false); setLoginOpen(true) }}>
          <UserPlus />
          {t("nav.account.addAnotherAccount")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleLogout("single")}>
          <LogOut />
          {t("nav.account.logOut")}
        </DropdownMenuItem>
        {sessions.length > 1 && (
          <DropdownMenuItem variant="destructive" onClick={() => handleLogout("all")}>
            <LogOut />
            {t("nav.account.signOutAllAccounts")}
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
    </>
  )

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className={cn(
                "flex items-center gap-2 text-sm",
                isHeader
                  ? "h-9 rounded-xl bg-card px-2 transition-shadow"
                  : compact
                    ? "h-8 w-8 justify-center rounded-md p-0 hover:bg-accent"
                    : "w-full rounded-md px-1.5 py-1.5 hover:bg-accent",
              )}
              aria-label={t("nav.account.menuLabel", { username: active.username })}
            />
          }
        >
          <InitialsAvatar name={active.username} size="xs" shape={isHeader ? "circle" : "square"} />
          {!compact && (
            <>
              <span className={cn("truncate font-medium", !isHeader && "flex-1 text-start")}>
                {active.username}
              </span>
              <ChevronDown className={cn("size-4 opacity-50", !isHeader && "ms-auto")} />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-72 rounded-lg"
          side="bottom"
          align={isHeader ? "end" : "start"}
          sideOffset={4}
        >
          {menuContent}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
        <DialogContent className="max-w-sm">
          <AuthDialogBody isAdditional onDone={() => setLoginOpen(false)} returnTo={returnTo} />
        </DialogContent>
      </Dialog>
      <Dialog open={!!pendingLogout} onOpenChange={(v) => { if (!v) setPendingLogout(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("nav.account.unsavedEditsTitle")}</DialogTitle>
            <DialogDescription>
              {t("nav.account.unsavedEditsDescription", {
                count: pendingLogout?.count ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPendingLogout(null)}>{t("common.cancel")}</Button>
            <Button
              variant="destructive"
              onClick={async () => {
                const scope = pendingLogout!.scope
                setPendingLogout(null)
                await doLogout(scope)
              }}
            >
              {t("nav.account.logOutAnyway")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Non-prod environment label derived from the Vite mode at build time. */
const ENV_HINT: string | null = (() => {
  const mode = import.meta.env.MODE as string | undefined
  if (!mode || mode === "production") return null
  if (mode === "development") return "dev"
  return mode
})()

interface EntrySummary {
  key: string
  username: string
  email?: string
  active: boolean
}

function AccountMenuEntry({
  summary,
  onSelect,
}: {
  summary: EntrySummary
  onSelect?: () => void
}) {
  return (
    <DropdownMenuItem
      className={ACCOUNT_MENU_ITEM_CLASS}
      onClick={onSelect}
      onSelect={(event) => {
        if (!onSelect) event.preventDefault()
      }}
    >
      <InitialsAvatar name={summary.username} size="xs" shape="square" menuSafe />
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium">{summary.username}</span>
          {summary.email && (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{summary.email}</span>
          )}
        </div>
        {ENV_HINT && (
          <span className="truncate text-xs text-amber-600 dark:text-amber-500">{ENV_HINT}</span>
        )}
      </div>
      {summary.active && <Check className="size-4 shrink-0 opacity-60" />}
    </DropdownMenuItem>
  )
}
