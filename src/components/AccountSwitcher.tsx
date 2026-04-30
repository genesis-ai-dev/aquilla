import { useState, useEffect, useRef } from "react"
import { ChevronsUpDown, LogIn, LogOut, UserPlus, Check } from "lucide-react"
import { useAccounts } from "@/hooks/useAccounts"
import { clearSession } from "@/lib/frontier/session-store"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { FrontierLoginForm } from "./git-import/FrontierLoginForm"
import { FrontierSignupForm } from "./git-import/FrontierSignupForm"
import { FrontierForgotPasswordForm } from "./git-import/FrontierForgotPasswordForm"
import { cn } from "@/lib/utils"

type AuthMode = "login" | "signup" | "forgot"

function AuthDialogBody({
  isAdditional,
  onDone,
}: {
  isAdditional: boolean
  onDone: () => void
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
        <FrontierForgotPasswordForm onBack={() => setMode("login")} />
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

export function AccountSwitcher({ variant = "sidebar" }: { variant?: "sidebar" | "header" } = {}) {
  const { active, sessions, activate, remove } = useAccounts()
  const [open, setOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  const isHeader = variant === "header"

  if (!active) {
    return (
      <>
        <button
          className={cn(
            "flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent",
            !isHeader && "w-full",
            isHeader && "border h-9",
          )}
          onClick={() => setLoginOpen(true)}
        >
          <LogIn className="h-4 w-4" />
          <span>Log in</span>
        </button>
        <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
          <DialogContent className="max-w-sm">
            <AuthDialogBody isAdditional={false} onDone={() => setLoginOpen(false)} />
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
          "flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent",
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
            "absolute top-full mt-1 z-50 w-60 rounded-md border bg-popover p-1 shadow-md",
            isHeader ? "right-0" : "left-0",
          )}
        >
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Signed in
          </div>
          {activeSummary && <Entry summary={activeSummary} />}
          {others.length > 0 && (
            <>
              <div className="my-1 h-px bg-border" />
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
          <div className="my-1 h-px bg-border" />
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => { setOpen(false); setLoginOpen(true) }}
          >
            <UserPlus className="h-4 w-4" />
            <span>Add another account…</span>
          </button>
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => { setOpen(false); clearSession() }}
          >
            <LogOut className="h-4 w-4" />
            <span>Log out</span>
          </button>
        </div>
      )}
      <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
        <DialogContent className="max-w-sm">
          <AuthDialogBody isAdditional onDone={() => setLoginOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface EntrySummary {
  key: string
  username: string
  gitlabUrl: string
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
        "group flex items-center gap-2 rounded px-2 py-1.5 text-sm",
        !summary.active && "hover:bg-accent cursor-pointer",
      )}
      onClick={onClick}
    >
      <div
        className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white"
        style={{ backgroundColor: colorFor(summary.username) }}
      >
        {initials(summary.username)}
      </div>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="truncate">{summary.username}</span>
        <span className="truncate text-[10px] text-muted-foreground">{summary.gitlabUrl}</span>
      </div>
      {summary.active && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
      {onRemove && !summary.active && (
        <button
          className="ml-1 rounded px-1 text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          aria-label={`Remove ${summary.username}`}
        >
          remove
        </button>
      )}
    </div>
  )
}
