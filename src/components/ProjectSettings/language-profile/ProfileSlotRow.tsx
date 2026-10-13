// One collapsible row of the "Language profile for checks" card (AQU-1691).
//
// Closed, a row shows the slot's title and whether it is set, so a project
// that fills in only a few slots sees a short, calm list. Open, it explains
// the slot in one sentence, gives one example, and edits a draft. Save checks
// the value with the slot's own validator first: a value that cannot become a
// valid slot is reported, never stored half-right.

import { useState, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import { DisabledFieldTooltip } from "../DisabledFieldTooltip"

export interface ProfileSlotRowProps<D> {
  /** The slot name, for test ids and element ids. */
  slot: string
  title: string
  description: string
  example: string
  /** The stored slot value as it is (it may be damaged), or undefined. */
  stored: unknown
  /** The slot holds a valid value, so its checks can run. */
  isSet: boolean
  toDraft: (stored: unknown) => D
  /** The value to store, or null while the draft holds nothing to store. */
  toValue: (draft: D) => unknown
  /** The slot's validator: null when `value` may be stored. */
  problem: (value: unknown) => string | null
  canEdit: boolean
  disabledTooltip: ReactNode
  /** Store the slot, or clear it with `undefined`. Resolves to an error message, or null. */
  onSave: (value: unknown) => Promise<string | null>
  children: (draft: D, setDraft: (next: D) => void, disabled: boolean) => ReactNode
}

type Status = { kind: "saved" } | { kind: "error"; message: string } | null

export function ProfileSlotRow<D>(props: ProfileSlotRowProps<D>) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const storedKey = JSON.stringify(props.stored ?? null)
  const [syncedKey, setSyncedKey] = useState(storedKey)
  const [draft, setDraft] = useState<D>(() => props.toDraft(props.stored))
  const [status, setStatus] = useState<Status>(null)
  const [saving, setSaving] = useState(false)
  // A save here or elsewhere changed the stored slot: show what is stored now.
  if (syncedKey !== storedKey) {
    setSyncedKey(storedKey)
    setDraft(props.toDraft(props.stored))
  }
  const disabled = !props.canEdit || saving
  const contentId = `language-profile-${props.slot}`

  async function save(value: unknown) {
    setSaving(true)
    try {
      const error = await props.onSave(value)
      setStatus(error ? { kind: "error", message: error } : { kind: "saved" })
    } finally {
      setSaving(false)
    }
  }

  function handleSave() {
    const value = props.toValue(draft)
    if (value === null || props.problem(value) !== null) {
      setStatus({ kind: "error", message: t("languageProfile.invalid") })
      return
    }
    void save(value)
  }

  return (
    <div className="px-4 py-3" data-testid={`profile-slot-${props.slot}`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={contentId}
            className="flex w-full items-center justify-between gap-3 text-left text-sm"
          >
            <span className="font-medium">{props.title}</span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              {props.isSet ? t("languageProfile.set") : t("languageProfile.notSet")}
              <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} aria-hidden />
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3">
          <div id={contentId} className="space-y-3">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{props.description}</p>
              <p className="text-xs">{t("languageProfile.example", { example: props.example })}</p>
            </div>
            <DisabledFieldTooltip disabled={!props.canEdit} tooltip={props.disabledTooltip}>
              <div className="max-w-xl space-y-3">
                {props.children(
                  draft,
                  (next) => {
                    setStatus(null)
                    setDraft(next)
                  },
                  disabled,
                )}
              </div>
            </DisabledFieldTooltip>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" disabled={disabled} onClick={handleSave}>
                {t("common.save")}
              </Button>
              {props.stored !== undefined ? (
                <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => void save(undefined)}>
                  {t("common.clear")}
                </Button>
              ) : null}
            </div>
            {status ? (
              <p
                role={status.kind === "error" ? "alert" : "status"}
                className={status.kind === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
              >
                {status.kind === "error" ? status.message : t("languageProfile.saved")}
              </p>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
