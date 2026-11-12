import { useId, useState } from "react"
import { Wand2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"

/** "Change with AI": one composer-style line under the header. The change
 *  becomes a new version (undo = go back a version). */
export function ChangeWithAi({
  busy,
  error,
  onSubmit,
  onClose,
}: {
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
      className="border-b bg-muted/30 px-3 py-3 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0 sm:px-4 dark:bg-input/10"
      data-testid="change-with-ai"
    >
      <form
        className="mx-auto flex max-w-2xl items-center gap-2 rounded-2xl border bg-card p-1.5 ps-4 shadow-xs"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label htmlFor={`${id}-input`} className="sr-only">{t("extensions.detail.changeTitle")}</label>
        <input
          id={`${id}-input`}
          autoFocus
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          placeholder={t("extensions.change.placeholder")}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="button" size="icon-sm" variant="ghost" onClick={onClose} aria-label={t("common.close")}>
          <X className="size-3.5" />
        </Button>
        <Button type="submit" size="sm" className="rounded-full" disabled={busy || !value.trim()}>
          {busy ? <Spinner className="size-3.5" /> : <Wand2 className="size-3.5" aria-hidden />}
          {busy ? t("extensions.detail.changing") : t("extensions.change.submit")}
        </Button>
      </form>
      {error && <p role="alert" className="mx-auto mt-2 max-w-2xl text-xs text-destructive">{t("extensions.heal.failed", { message: error.slice(0, 300) })}</p>}
    </section>
  )
}
