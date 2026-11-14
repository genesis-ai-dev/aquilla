// The tags a line is spoken with (AQU-2577), as chips: the suggested ones, the
// line's own, and "Other…" for one typed in. Shared by the clip inspector (a
// line that has a take) and Make speech (lines that have none yet).
import { useState } from "react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { MAX_LINE_TAGS, normalizeLineTag, SUGGESTED_LINE_TAGS } from "@/lib/audio/line-delivery"

export function LineTagChips({ tags, disabled, onChange, testId }: {
  tags: readonly string[]
  disabled?: boolean
  onChange: (next: string[]) => void
  testId?: string
}) {
  const t = useT()
  const [customTag, setCustomTag] = useState<string | null>(null)
  const set = (next: string[]) => onChange(next.slice(0, MAX_LINE_TAGS))
  const toggle = (tag: string) => set(tags.includes(tag) ? tags.filter((x) => x !== tag) : [...tags, tag])
  const addCustom = () => {
    const tag = normalizeLineTag(customTag ?? "")
    if (tag && !tags.includes(tag)) set([...tags, tag])
    setCustomTag(null)
  }
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
      {[...new Set([...SUGGESTED_LINE_TAGS, ...tags])].map((tag) => (
        <button
          key={tag} type="button" aria-pressed={tags.includes(tag)} disabled={disabled}
          className={cn(
            "h-6 rounded-full border px-2 text-xs disabled:opacity-50",
            tags.includes(tag) ? "border-primary bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent",
          )}
          onClick={() => toggle(tag)}
        >
          {tag}
        </button>
      ))}
      {customTag == null ? (
        <button
          type="button" disabled={disabled}
          className="h-6 rounded-full border border-dashed px-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
          onClick={() => setCustomTag("")}
        >
          {t("audio.inspector.otherTag")}
        </button>
      ) : (
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); addCustom() }}>
          <Input
            autoFocus value={customTag} onChange={(e) => setCustomTag(e.target.value)}
            onBlur={addCustom}
            aria-label={t("audio.inspector.otherTagAriaLabel")}
            placeholder={t("audio.inspector.otherTagPlaceholder")}
            className="h-6 w-32 px-2 text-xs"
          />
        </form>
      )}
    </div>
  )
}
