// "Clone voice from take" does what it says (AQU-2212): name the voice, press
// Clone, and this take becomes a cast voice — no modal. "More options" still
// opens the full New voice dialog seeded with the take (engine, other clips).
import { useState } from "react"
import { CopyPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useT } from "@/lib/i18n/I18nProvider"

export interface CloneFromTakeButtonProps {
  /** Prefills the name, e.g. who recorded the take. */
  suggestedName?: string
  onClone: (name: string) => Promise<void>
  onMoreOptions: () => void
}

export function CloneFromTakeButton({ suggestedName = "", onClone, onMoreOptions }: CloneFromTakeButtonProps) {
  const t = useT()
  const [open, setOpenState] = useState(false)
  const [name, setName] = useState(suggestedName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = t("editor.voice.clone")
  const setOpen = (next: boolean) => {
    if (busy) return
    if (next) {
      setName(suggestedName)
      setError(null)
    }
    setOpenState(next)
  }
  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onClone(name.trim())
      setOpenState(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <AppTooltip content={label}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              data-testid="voice-card-clone"
              className="shrink-0 text-muted-foreground"
            />
          }
        >
          <CopyPlus className="h-3.5 w-3.5" />
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent align="end" side="bottom" className="w-64 p-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <p className="text-sm font-medium">{t("editor.voice.cloneTitle")}</p>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("editor.voice.cloneNamePlaceholder")}
            aria-label={t("editor.voice.cloneNameAriaLabel")}
            data-testid="voice-card-clone-name"
            className="h-8"
          />
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="link"
              size="xs"
              className="px-0 text-muted-foreground"
              disabled={busy}
              onClick={() => {
                setOpenState(false)
                onMoreOptions()
              }}
            >
              {t("editor.voice.cloneMoreOptions")}
            </Button>
            <Button type="submit" size="sm" disabled={busy || !name.trim()} data-testid="voice-card-clone-submit">
              {busy && <Spinner className="size-3" />}
              {t("editor.voice.cloneSubmit")}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
