import { useId, useRef } from "react"
import { AppWindow, ArrowUp, CircleDashed, Hash, ListChecks, PanelRight, PenLine, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { EXAMPLE_PROMPTS, WHERE_CHOICES, type WhereChoice } from "@/lib/tools/builder-model"
import { cn } from "@/lib/utils"

const WHERE = {
  auto: { icon: Sparkles, label: "extensions.where.auto" },
  panel: { icon: PanelRight, label: "extensions.where.choicePanel" },
  page: { icon: AppWindow, label: "extensions.where.choicePage" },
  editor: { icon: PenLine, label: "extensions.where.choiceEditor" },
} as const

const SUGGESTION_ICON = [ListChecks, Hash, CircleDashed, PenLine] as const

/** Where it appears: a compact icon segmented control inside the composer.
 *  The selected option shows its label; the others say it on hover. */
function WherePicker({ value, onChange, disabled }: { value: WhereChoice; onChange: (w: WhereChoice) => void; disabled: boolean }) {
  const t = useT()
  return (
    <div role="radiogroup" aria-label={t("extensions.describe.where")} className="inline-flex items-center gap-0.5 rounded-full bg-muted p-0.5">
      {WHERE_CHOICES.map((w) => {
        const { icon: Icon, label } = WHERE[w]
        const on = w === value
        const button = (
          <button
            key={w}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={t(label)}
            disabled={disabled}
            onClick={() => onChange(w)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-xs font-medium transition-[background-color,color,box-shadow] duration-150 ease-out",
              "focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-50",
              on ? "bg-background px-2.5 text-foreground shadow-xs dark:bg-input/60" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {on && <span>{t(label)}</span>}
          </button>
        )
        return on ? button : <AppTooltip key={w} content={t(label)}>{button}</AppTooltip>
      })}
    </div>
  )
}

/** Step 1 — the prompt composer: the page's hero. Build lives inside it. */
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
  const box = useRef<HTMLTextAreaElement | null>(null)
  const ready = value.trim().length > 0 && !disabled
  return (
    <section className="flex flex-col items-center gap-5" data-testid="builder-describe">
      <h2 className="text-center text-2xl font-semibold tracking-[-0.02em] text-balance sm:text-[28px]">{t("extensions.hero.title")}</h2>
      <div
        className={cn(
          "w-full rounded-2xl border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-16px_rgb(0_0_0/0.18)]",
          "transition-[border-color,box-shadow] duration-200 ease-out focus-within:border-foreground/20 focus-within:ring-4 focus-within:ring-primary/10",
          "dark:shadow-[0_0_0_1px_rgb(255_255_255/0.02),0_16px_40px_-20px_rgb(0_0_0/0.6)]",
        )}
      >
        <label htmlFor={`${id}-box`} className="sr-only">{t("extensions.describe.label")}</label>
        <textarea
          id={`${id}-box`}
          ref={box}
          autoFocus
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
          className="block max-h-80 min-h-28 w-full resize-none bg-transparent px-5 pt-4.5 pb-2 text-[15px] leading-6 outline-none [field-sizing:content] placeholder:text-muted-foreground/60 disabled:opacity-60"
        />
        <div className="flex items-center gap-2 px-3 pb-3">
          <WherePicker value={where} onChange={onWhereChange} disabled={disabled} />
          <AppTooltip content={t("extensions.describe.shortcut")}>
            <span className="ms-auto hidden font-mono text-[11px] text-muted-foreground/70 select-none sm:inline">⌘↵</span>
          </AppTooltip>
          <Button
            onClick={onBuild}
            disabled={!ready}
            className="h-8 gap-1.5 rounded-full ps-3 pe-3.5 transition-[transform,background-color] duration-150 ease-out active:scale-[0.97] disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 max-sm:ms-auto motion-reduce:active:scale-100"
            data-testid="builder-build"
          >
            <ArrowUp className="size-4" aria-hidden />
            {t("extensions.describe.build")}
          </Button>
        </div>
      </div>
      <ul className="flex flex-wrap justify-center gap-2" aria-label={t("extensions.describe.examples")}>
        {EXAMPLE_PROMPTS.map((ex, i) => {
          const Icon = SUGGESTION_ICON[i] ?? Sparkles
          return (
            <li key={ex.prompt}>
              <AppTooltip content={t(ex.prompt)}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onChange(t(ex.prompt))
                    onWhereChange(ex.where)
                    box.current?.focus()
                  }}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-[13px] text-muted-foreground",
                    "transition-[background-color,color,border-color,transform] duration-150 ease-out hover:border-foreground/15 hover:text-foreground active:scale-[0.97]",
                    "focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none disabled:opacity-50 motion-reduce:active:scale-100 dark:bg-transparent",
                  )}
                  data-testid="builder-example"
                >
                  <Icon className="size-3.5" aria-hidden />
                  {t(ex.title)}
                </button>
              </AppTooltip>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
