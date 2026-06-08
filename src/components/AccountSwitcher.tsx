import { useState, useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useLocation } from "react-router-dom"
import { ChevronsUpDown, LogIn, LogOut, UserPlus, Check, Settings2 } from "lucide-react"
import { useAccounts } from "@/hooks/useAccounts"
import { clearSession, listSessions, removeSession } from "@/lib/frontier/session-store"
import { clearAllLocalData } from "@/lib/store/project-index"
import { outboxPendingCount } from "@/lib/sync/outbox"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { FrontierLoginForm } from "./git-import/FrontierLoginForm"
import { FrontierSignupForm } from "./git-import/FrontierSignupForm"
import { FrontierForgotPasswordForm } from "./git-import/FrontierForgotPasswordForm"
import { cn } from "@/lib/utils"

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

function initials(name: string): string {
  const t = name.trim()
  if (!t) return "?"
  const parts = t.split(/\s+/)
  if (parts.length === 1) return t.slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  const hue = Math.abs(h) % 360
  return `hsl(${hue}, 55%, 45%)`
}

type LogoutScope = "single" | "all"

export function AccountSwitcher({ variant = "sidebar" }: { variant?: "sidebar" | "header" } = {}) {
  const { active, sessions, activate, remove } = useAccounts()
  const qc = useQueryClient()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [pendingLogout, setPendingLogout] = useState<{ count: number; scope: LogoutScope } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // Capture the destination before showing the login dialog so the user
  // returns to the same page after reset → login.
  const returnTo = location.pathname !== "/" ? location.pathname + location.search : undefined

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

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
            "flex items-center gap-2 rounded-xl bg-card px-2 py-1.5 text-sm transition-shadow hover:shadow-neu-xs",
            !isHeader && "w-full",
            isHeader && "shadow-neu-sm h-9",
          )}
          onClick={() => setLoginOpen(true)}
        >
          <LogIn className="h-4 w-4" />
          <span>Log in</span>
        </button>
        <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
          <DialogContent className="max-w-sm">
            <AuthDialogBody isAdditional={false} onDone={() => setLoginOpen(false)} returnTo={returnTo} />
          </DialogContent>
        </Dialog>
      </>
    )
  }

  const others = sessions.filter((s) => !s.active)
  const activeSummary = sessions.find((s) => s.active)

  return (
    <div ref={rootRef} className="relative">
      <button
        className={cn(
          "flex items-center gap-2 rounded-xl bg-card px-2 py-1.5 text-sm transition-shadow hover:shadow-neu-xs",
          !isHeader && "w-full",
          isHeader && "h-9",
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <div
          className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white"
          style={{ backgroundColor: colorFor(active.username) }}
        >
          {initials(active.username)}
        </div>
        <span className={cn("truncate text-left", !isHeader && "flex-1")}>{active.username}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div
          className={cn(
            "neu-raised absolute z-40 w-60 rounded-2xl p-1.5",
            isHeader ? "top-full mt-2 right-0" : "bottom-full mb-2 left-0",
          )}
        >
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Signed in
          </div>
          {activeSummary && <Entry summary={activeSummary} />}
          {others.length > 0 && (
            <>
              <div className="my-1.5 h-px bg-foreground/5" />
              <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Switch to
              </div>
              {others.map((s) => (
                <Entry
                  key={s.key} summary={s}
                  onClick={() => { setOpen(false); activate(s.key) }}
                  onRemove={() => remove(s.key)}
                />
              ))}
            </>
          )}
          <div className="my-1.5 h-px bg-foreground/5" />
          <Link
            to="/preferences"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 rounded-xl bg-card px-2 py-1.5 text-sm transition-shadow hover:shadow-neu-xs"
          >
            <Settings2 className="h-4 w-4" />
            <span>Preferences</span>
          </Link>
          <button
            className="flex w-full items-center gap-2 rounded-xl bg-card px-2 py-1.5 text-sm transition-shadow hover:shadow-neu-xs"
            onClick={() => { setOpen(false); setLoginOpen(true) }}
          >
            <UserPlus className="h-4 w-4" />
            <span>Add another account…</span>
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-xl bg-card px-2 py-1.5 text-sm transition-shadow hover:shadow-neu-xs"
            onClick={() => handleLogout("single")}
          >
            <LogOut className="h-4 w-4" />
            <span>Log out</span>
          </button>
          {sessions.length > 1 && (
            <button
              className="flex w-full items-center gap-2 rounded-xl bg-card px-2 py-1.5 text-sm text-destructive transition-shadow hover:shadow-neu-xs"
              onClick={() => handleLogout("all")}
            >
              <LogOut className="h-4 w-4" />
              <span>Sign out of all accounts</span>
            </button>
          )}
        </div>
      )}
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
    </div>
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

function Entry({
  summary, onClick, onRemove,
}: {
  summary: EntrySummary
  onClick?: () => void
  onRemove?: () => void
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm",
        !summary.active && "bg-card cursor-pointer transition-shadow hover:shadow-neu-xs",
        summary.active && "shadow-neu-inset",
      )}
      onClick={onClick}
    >
      <div
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
        style={{ backgroundColor: colorFor(summary.username) }}
      >
        {initials(summary.username)}
      </div>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="truncate">{summary.username}</span>
        {summary.email && (
          <span className="truncate text-[10px] text-muted-foreground">{summary.email}</span>
        )}
        {ENV_HINT && (
          <span className="truncate text-[10px] text-amber-600 dark:text-amber-500">{ENV_HINT}</span>
        )}
      </div>
      {summary.active && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
      {onRemove && !summary.active && (
        <button
          className="ml-1 rounded-full px-1 text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          aria-label={`Remove ${summary.username}`}
        >
          remove
        </button>
      )}
    </div>
  )
}
