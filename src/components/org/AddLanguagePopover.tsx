// AQU-538 §3.2 — "+ Language" quick action on an OrgHome project row.
//
// "Add languages from the org dashboard" without opening /project/:id/editor settings.
// Same validation as ProjectSettings' LanguagesSection (trim / <=64 / case-
// insensitive dedupe against the default target language + existing lanes),
// then creates a target lane on that project. A below-maintainer caller gets
// a 403 surfaced inline — the caller need not know their role up front
// (§3.2: "if absent for a row, show and let the 403 surface gracefully").

import { useState } from "react"
import { Languages, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LanguageComboboxInput } from "@/components/LanguageComboboxInput"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import {
  createProjectLane,
  fetchProjectSettings,
  type ProjectLaneView,
  type ProjectSettingsResponse,
} from "@/lib/sync/project-settings"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { laneLanguage } from "@/lib/lanes/lane-display"
import { laneLanguageForTag } from "@/lib/lanes/lane-language"
import { isPrimaryRegistryLane } from "@/lib/lanes/registry-lanes"

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
  t: TFunction,
  candidate: string,
  defaultTargetLanguage: string,
  existingLanes: string[],
): string | null {
  const trimmed = candidate.trim()
  if (!trimmed) return t("projectSettings.create.extraLanguagesEmptyError")
  if (trimmed.length > MAX_LANE_LENGTH) {
    return t("projectSettings.create.extraLanguagesTooLongError", { max: MAX_LANE_LENGTH })
  }
  if (defaultTargetLanguage && isPrimaryRegistryLane(trimmed, defaultTargetLanguage)) {
    return t("projectSettings.languages.alreadyDefaultError")
  }
  if (existingLanes.some((lane) => isPrimaryRegistryLane(trimmed, lane))) {
    return t("projectSettings.languages.alreadyExistsError")
  }
  return null
}

function laneLanguagesOf(res: ProjectSettingsResponse): string[] {
  const rows = (res.lanes ?? []).filter((lane): lane is ProjectLaneView => lane.role === "target")
  if (rows.length > 0) {
    return rows
      .map((lane) =>
        laneLanguage(lane, { settings: res.settings, role: "target", legacyTag: lane.legacyTag }),
      )
      .filter((language) => language.length > 0)
  }
  return (res.settings.targetLanes ?? []).filter((lane) => lane.trim().length > 0)
}

type Phase = "idle" | "loading" | "ready" | "saving"

export function AddLanguagePopover({ projectId, jwt, onAdded }: AddLanguagePopoverProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>("idle")
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  // Snapshot of the current settings, loaded on open — needed for the version
  // pin (ifMatchVersion), default-language dedupe, and existing-lane dedupe.
  const [snapshot, setSnapshot] = useState<{
    defaultTargetLanguage: string
    laneLanguages: string[]
  } | null>(null)

  async function loadSettings() {
    setPhase("loading")
    setError(null)
    const res = await fetchProjectSettings(jwt, projectId)
    if (!res) {
      setSnapshot(null)
      setError(t("org.addLanguagePopover.loadError"))
      setPhase("ready")
      return
    }
    setSnapshot({
      defaultTargetLanguage: laneLanguageForTag("", res.lanes, res.settings) ?? "",
      laneLanguages: laneLanguagesOf(res),
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

  async function handleAdd(language?: string) {
    if (!snapshot) {
      setError(t("org.addLanguagePopover.loadError"))
      return
    }
    const trimmed = (language ?? value).trim()
    const validationError = validateNewLane(
      t,
      trimmed,
      snapshot.defaultTargetLanguage,
      snapshot.laneLanguages,
    )
    if (validationError) {
      setError(validationError)
      return
    }
    setPhase("saving")
    setError(null)
    const result = await createProjectLane(jwt, projectId, { name: "", language: trimmed })
    if (result.kind === "ok") {
      setValue("")
      setSnapshot({
        defaultTargetLanguage: snapshot.defaultTargetLanguage,
        laneLanguages: [...snapshot.laneLanguages, trimmed],
      })
      setPhase("ready")
      onAdded?.(trimmed)
      setOpen(false)
      return
    }
    if (result.kind === "duplicate") {
      setError(t("projectSettings.languages.alreadyExistsError"))
      setPhase("ready")
      return
    }
    if (result.kind === "error" && result.message.includes("(403)")) {
      setError(t("org.addLanguagePopover.forbiddenError"))
      setPhase("ready")
      return
    }
    setError(result.kind === "error" ? result.message : t("projectSettings.languages.savingFailedGeneric"))
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
            aria-label={t("org.addLanguagePopover.triggerAriaLabel")}
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
          <p className="text-xs font-medium">{t("org.addLanguagePopover.heading")}</p>
          <p className="text-[11px] text-muted-foreground">
            {t("org.addLanguagePopover.description")}
          </p>
        </div>
        {phase === "loading" ? (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Spinner className="size-3.5" />
            {t("org.addLanguagePopover.loadingLanguages")}
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <LanguageComboboxInput
              autoFocus
              value={value}
              onValueChange={(next) => {
                setValue(next)
                setError(null)
              }}
              onEnterSelect={(name) => {
                setValue(name)
                setError(null)
                void handleAdd(name)
              }}
              exclude={
                snapshot
                  ? [snapshot.defaultTargetLanguage, ...snapshot.laneLanguages].filter(
                      (language) => language.trim().length > 0,
                    )
                  : []
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void handleAdd()
                }
              }}
              placeholder={t("projectSettings.create.extraLanguagesPlaceholder")}
              aria-label={t("org.addLanguagePopover.inputAriaLabel")}
              className="h-8 text-xs"
              disabled={busy}
            />
            <Button size="sm" onClick={() => void handleAdd()} disabled={busy || !snapshot}>
              {busy ? <Spinner className="me-1 size-3.5" /> : <Plus className="me-1 size-3.5" />}
              {t("common.add")}
            </Button>
          </div>
        )}
        {error && <p className="text-[11px] text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  )
}
