import { useId, useState } from "react"
import { Wand2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"

/** "Change {name} with AI": a labelled panel, not a bare input in a toolbar.
 *  The change becomes a new version (undo = go back a version). */
export function ChangeWithAi({
  name,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  name: string
  busy: boolean
  error: string | null
  onSubmit: (request: string) => Promise<boolean>
  onClose: () => void
}) {
  const t = useT()
  const id = useId()
  const [value, setValue] = useState("")
  const submit = async () => {
    const words = value.trim()
    if (!words || busy) return
    if (await onSubmit(words)) setValue("")
  }
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="border-b bg-muted/30 px-4 py-3 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0"
      data-testid="change-with-ai"
    >
      <form
        className="mx-auto flex max-w-3xl flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <label id={`${id}-title`} htmlFor={`${id}-input`} className="block text-sm font-medium">
              {t("extensions.detail.changeTitle", { name })}
            </label>
            <p className="text-xs text-muted-foreground">{t("extensions.detail.changeHelp")}</p>
          </div>
          <Button type="button" size="icon-xs" variant="ghost" onClick={onClose} aria-label={t("common.close")}>
            <X className="size-3.5" />
          </Button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={`${id}-input`}
            autoFocus
            className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20"
            placeholder={t("extensions.change.placeholder")}
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" disabled={busy || !value.trim()}>
            {busy ? <Spinner className="size-3.5" /> : <Wand2 className="size-3.5" aria-hidden />}
            {busy ? t("extensions.detail.changing") : t("extensions.change.submit")}
          </Button>
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{t("extensions.heal.failed", { message: error.slice(0, 300) })}</p>}
      </form>
    </section>
  )
}
