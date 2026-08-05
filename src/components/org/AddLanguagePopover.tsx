// AQU-538 §3.2 — "+ Language" quick action on an OrgHome project row.
//
// "Add languages from the org dashboard" without opening /project/:id/editor settings.
// Same validation as ProjectSettings' LanguagesSection (trim / <=64 / case-
// insensitive dedupe against the default target language + existing lanes),
// then PATCHes that project's `settings.targetLanes`.
//
// The settings PATCH is optimistic-concurrency guarded (ifMatchVersion), so we
// fetch the current settings on open to learn the version, the default target
// language (for dedupe), and the existing lane registry. A stale version yields
// a 409 (conflict) surfaced inline; a below-maintainer caller yields a 403
// (forbidden) surfaced inline — the caller need not know their role up front
// (§3.2: "if absent for a row, show and let the PATCH 403 surface gracefully").

import { useState } from "react"
import { Languages, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import {
  fetchProjectSettings,
  patchProjectSettings,
} from "@/lib/sync/project-settings"

const MAX_LANE_LENGTH = 64

export interface AddLanguagePopoverProps {
  projectId: string
  jwt: string
  /** Called with the newly-added lane tag after a successful add, so the parent
   * can insert it in place (AQU-605) rather than refetching the whole table. */
  onAdded?: (lane: string) => void
}

/** Mirrors LanguagesSection.validateNewLane — kept local so this org-dashboard
 * control doesn't depend on the ProjectSettings module. */
function validateNewLane(
  candidate: string,
  defaultTargetLanguage: string,
  existingLanes: string[],
): string | null {
  const trimmed = candidate.trim()
  if (!trimmed) return "Enter a language tag."
  if (trimmed.length > MAX_LANE_LENGTH) return `Must be ${MAX_LANE_LENGTH} characters or fewer.`
  const lower = trimmed.toLowerCase()
  if (lower === defaultTargetLanguage.trim().toLowerCase()) {
    return "This is already the default target language."
  }
  if (existingLanes.some((l) => l.toLowerCase() === lower)) {
    return "This lane already exists."
  }
  return null
}

type Phase = "idle" | "loading" | "ready" | "saving"

export function AddLanguagePopover({ projectId, jwt, onAdded }: AddLanguagePopoverProps) {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>("idle")
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  // Snapshot of the current settings, loaded on open — needed for the version
  // pin (ifMatchVersion), default-language dedupe, and existing-lane dedupe.
  const [snapshot, setSnapshot] = useState<{
    version: number
    defaultTargetLanguage: string
    targetLanes: string[]
  } | null>(null)

  async function loadSettings() {
    setPhase("loading")
    setError(null)
    const res = await fetchProjectSettings(jwt, projectId)
    if (!res) {
      setSnapshot(null)
      setError("Couldn't load this project's languages. Try again.")
      setPhase("ready")
      return
    }
    setSnapshot({
      version: res.version,
      defaultTargetLanguage: res.settings.targetLanguage ?? "",
      targetLanes: res.settings.targetLanes ?? [],
    })
    setPhase("ready")
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setValue("")
      setError(null)
      void loadSettings()
    } else {
      setSnapshot(null)
      setPhase("idle")
    }
  }

  async function handleAdd() {
    if (!snapshot) {
      setError("Couldn't load this project's languages. Try again.")
      return
    }
    const trimmed = value.trim()
    const validationError = validateNewLane(
      trimmed,
      snapshot.defaultTargetLanguage,
      snapshot.targetLanes,
    )
    if (validationError) {
      setError(validationError)
      return
    }
    setPhase("saving")
    setError(null)
    const result = await patchProjectSettings(
      jwt,
      projectId,
      { targetLanes: [...snapshot.targetLanes, trimmed] },
      snapshot.version,
    )
    if (result.kind === "ok") {
      setValue("")
      setSnapshot({
        version: result.value.version,
        defaultTargetLanguage: result.value.settings.targetLanguage ?? snapshot.defaultTargetLanguage,
        targetLanes: result.value.settings.targetLanes ?? [...snapshot.targetLanes, trimmed],
      })
      setPhase("ready")
      onAdded?.(trimmed)
      setOpen(false)
      return
    }
    if (result.kind === "conflict") {
      setSnapshot({
        version: result.latest.version,
        defaultTargetLanguage: result.latest.settings.targetLanguage ?? snapshot.defaultTargetLanguage,
        targetLanes: result.latest.settings.targetLanes ?? snapshot.targetLanes,
      })
      setError("Languages changed elsewhere. Reloaded — try adding again.")
      setPhase("ready")
      return
    }
    if (result.kind === "forbidden") {
      setError("You don't have permission to add languages to this project.")
      setPhase("ready")
      return
    }
    setError(result.message || "Saving failed.")
    setPhase("ready")
  }

  const busy = phase === "saving"

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-testid={`org-add-lang-${projectId}`}
            className="inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
            aria-label="Add a target language lane"
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        <Languages className="size-3.5" aria-hidden />
        <Plus className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        data-testid={`org-add-lang-popover-${projectId}`}
        className="w-72 space-y-2 p-3"
        side="bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <p className="text-xs font-medium">Add a target language</p>
          <p className="text-[11px] text-muted-foreground">
            Registers a new lane on this project. Manage or remove lanes in project settings.
          </p>
        </div>
        {phase === "loading" ? (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Spinner className="size-3.5" />
            Loading languages…
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <Input
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void handleAdd()
                }
              }}
              placeholder="e.g. fr-CA"
              aria-label="New target language tag"
              className="h-8 text-xs"
              disabled={busy}
            />
            <Button size="sm" onClick={() => void handleAdd()} disabled={busy || !snapshot}>
              {busy ? <Spinner className="mr-1 size-3.5" /> : <Plus className="mr-1 size-3.5" />}
              Add
            </Button>
          </div>
        )}
        {error && <p className="text-[11px] text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  )
}
