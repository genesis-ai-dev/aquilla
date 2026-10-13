import { useId } from "react"
import { ArrowUp, Lightbulb } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { SegmentTabs } from "@/components/ui/tabs"
import { useT } from "@/lib/i18n/I18nProvider"
import { EXAMPLE_PROMPT_KEYS, WHERE_CHOICES, type WhereChoice } from "@/lib/tools/builder-model"
import { cn } from "@/lib/utils"

const WHERE_LABEL = {
  auto: "extensions.where.auto",
  panel: "extensions.where.choicePanel",
  page: "extensions.where.choicePage",
  editor: "extensions.where.choiceEditor",
} as const

/** Step 1 — say what it should do. Plain label and help, clickable
 *  translation examples that fill the box, an optional placement, Build. */
export function DescribeStep({
  value,
  onChange,
  where,
  onWhereChange,
  onBuild,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  where: WhereChoice
  onWhereChange: (where: WhereChoice) => void
  onBuild: () => void
  disabled: boolean
}) {
  const t = useT()
  const id = useId()
  const ready = value.trim().length > 0 && !disabled
  return (
    <section aria-labelledby={`${id}-label`} className="flex flex-col gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5" data-testid="builder-describe">
      <div className="flex flex-col gap-1">
        <label id={`${id}-label`} htmlFor={`${id}-box`} className="text-base font-semibold tracking-tight">
          {t("extensions.describe.label")}
        </label>
        <p id={`${id}-help`} className="text-sm text-muted-foreground">{t("extensions.describe.help")}</p>
      </div>

      <div className="rounded-xl border bg-background transition-[border-color,box-shadow] duration-150 focus-within:border-ring/60 focus-within:ring-3 focus-within:ring-ring/15">
        <textarea
          id={`${id}-box`}
          aria-describedby={`${id}-help`}
          placeholder={t("extensions.describe.placeholder")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready) {
              e.preventDefault()
              onBuild()
            }
          }}
          rows={3}
          disabled={disabled}
          className="block w-full resize-none rounded-xl bg-transparent px-4 pt-3.5 pb-3 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:opacity-60"
        />
      </div>

      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Lightbulb className="size-3.5" aria-hidden />
          {t("extensions.describe.examples")}
        </p>
        <ul className="flex flex-wrap gap-1.5" aria-label={t("extensions.describe.examples")}>
          {EXAMPLE_PROMPT_KEYS.map((key) => (
            <li key={key}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(t(key))}
                className={cn(
                  "rounded-full border bg-background px-3 py-1 text-start text-xs text-foreground/80 transition-[background-color,transform] duration-150",
                  "hover:bg-muted active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none disabled:opacity-50",
                  "motion-reduce:active:scale-100",
                )}
                data-testid="builder-example"
              >
                {t(key)}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground" id={`${id}-where`}>{t("extensions.describe.where")}</span>
          <SegmentTabs<WhereChoice>
            aria-label={t("extensions.describe.where")}
            value={where}
            onValueChange={onWhereChange}
            options={WHERE_CHOICES.map((w) => ({ value: w, label: t(WHERE_LABEL[w]), disabled }))}
            listClassName="flex-wrap"
          />
          <span className="text-xs text-muted-foreground">{t("extensions.describe.whereHint")}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-end">
          <Kbd className="hidden sm:inline-flex" aria-label={t("extensions.describe.shortcut")}>⌘↵</Kbd>
          <Button size="lg" onClick={onBuild} disabled={!ready} className="gap-1.5 px-4" data-testid="builder-build">
            <ArrowUp className="size-4" aria-hidden />
            {t("extensions.describe.build")}
          </Button>
        </div>
      </div>
    </section>
  )
}
