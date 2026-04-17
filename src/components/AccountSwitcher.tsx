import { useState, useEffect, useRef } from "react"
import { ChevronsUpDown, LogIn, LogOut, UserPlus, Check } from "lucide-react"
import { useAccounts } from "@/hooks/useAccounts"
import { clearSession } from "@/lib/frontier/session-store"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { FrontierLoginForm } from "./git-import/FrontierLoginForm"
import { cn } from "@/lib/utils"

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

export function AccountSwitcher() {
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

  if (!active) {
    return (
      <>
        <button
          className="flex w-full items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent rounded"
          onClick={() => setLoginOpen(true)}
        >
          <LogIn className="h-4 w-4" />
          <span>Log in</span>
        </button>
        <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Log in to Frontier</DialogTitle></DialogHeader>
            <FrontierLoginForm onSuccess={() => setLoginOpen(false)} />
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
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
        onClick={() => setOpen((v) => !v)}
      >
        <div
          className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white"
          style={{ backgroundColor: colorFor(active.username) }}
        >
          {initials(active.username)}
        </div>
        <span className="truncate flex-1 text-left">{active.username}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-60 rounded-md border bg-popover p-1 shadow-md">
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
          <DialogHeader><DialogTitle>Add Frontier account</DialogTitle></DialogHeader>
          <FrontierLoginForm onSuccess={() => setLoginOpen(false)} />
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
