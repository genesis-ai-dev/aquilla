import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useLocation } from "react-router-dom"
import { ChevronDown, LogIn, LogOut, UserPlus, Check, Settings2 } from "lucide-react"
import { useAccounts } from "@/hooks/useAccounts"
import { clearSession, listSessions, removeSession } from "@/lib/frontier/session-store"
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
  const [mode, setMode] = useState<AuthMode>("login")
  const titles: Record<AuthMode, string> = {
    login: isAdditional ? "Add Frontier account" : "Log in to Frontier",
    signup: "Create a Frontier account",
    forgot: "Reset your password",
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
            New to Frontier?{" "}
            <button
              type="button"
              onClick={() => setMode("signup")}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Create an account
            </button>
          </p>
        </div>
      )}
      {mode === "signup" && (
        <div className="space-y-4">
          <FrontierSignupForm onSuccess={onDone} />
          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <button
              type="button"
              onClick={() => setMode("login")}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Log in
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
  const { active, sessions, activate, remove } = useAccounts()
  const qc = useQueryClient()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [pendingLogout, setPendingLogout] = useState<{ count: number; scope: LogoutScope } | null>(null)
  // Capture the destination before showing the login dialog so the user
  // returns to the same page after reset → login.
  const returnTo = location.pathname !== "/" ? location.pathname + location.search : undefined

  const isHeader = variant === "header"

  async function handleLogout(scope: LogoutScope) {
    setOpen(false)
    const count = await outboxPendingCount()
    if (count > 0) {
      setPendingLogout({ count, scope })
      return
    }
    await doLogout(scope)
  }

  async function doLogout(scope: LogoutScope) {
    if (scope === "all") {
      const all = await listSessions()
      for (const s of all) await removeSession(s.key)
    } else {
      await clearSession()
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
          aria-label="Log in"
          onClick={() => setLoginOpen(true)}
        >
          <LogIn className="h-4 w-4" />
          {!compact && <span>Log in</span>}
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
            onRemove={s.active ? undefined : () => remove(s.key)}
          />
        ))}
      </DropdownMenuGroup>
      <DropdownMenuSeparator className="mx-0 my-1" />
      <DropdownMenuGroup>
        <DropdownMenuItem render={<Link to="/preferences" onClick={() => setOpen(false)} />}>
          <Settings2 />
          Preferences
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => { setOpen(false); setLoginOpen(true) }}>
          <UserPlus />
          Add another account…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleLogout("single")}>
          <LogOut />
          Log out
        </DropdownMenuItem>
        {sessions.length > 1 && (
          <DropdownMenuItem variant="destructive" onClick={() => handleLogout("all")}>
            <LogOut />
            Sign out of all accounts
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
              aria-label={`Account menu: ${active.username}`}
            />
          }
        >
          <InitialsAvatar name={active.username} size="xs" shape={isHeader ? "circle" : "square"} />
          {!compact && (
            <>
              <span className={cn("truncate font-medium", !isHeader && "flex-1 text-left")}>
                {active.username}
              </span>
              <ChevronDown className={cn("size-4 opacity-50", !isHeader && "ml-auto")} />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-60 rounded-lg"
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
            <DialogTitle>Unsaved edits</DialogTitle>
            <DialogDescription>
              You have {pendingLogout?.count ?? 0} unsaved edit{(pendingLogout?.count ?? 0) !== 1 ? "s" : ""} that haven't synced to the server. Logging out will discard them. Continue?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPendingLogout(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={async () => {
                const scope = pendingLogout!.scope
                setPendingLogout(null)
                await doLogout(scope)
              }}
            >
              Log out anyway
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
  onRemove,
}: {
  summary: EntrySummary
  onSelect?: () => void
  onRemove?: () => void
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
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{summary.username}</span>
        {summary.email && (
          <span className="truncate text-xs text-muted-foreground">{summary.email}</span>
        )}
        {ENV_HINT && (
          <span className="truncate text-xs text-amber-600 dark:text-amber-500">{ENV_HINT}</span>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        {summary.active && <Check className="size-4 opacity-60" />}
        {onRemove && !summary.active && (
          <Button
            type="button"
            variant="destructive"
            size="xs"
            className="shrink-0"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); onRemove() }}
            aria-label={`Remove ${summary.username}`}
          >
            Remove
          </Button>
        )}
        {!summary.active && !onRemove && <span aria-hidden />}
      </span>
    </DropdownMenuItem>
  )
}
