import { useState, type ReactNode } from "react"
import { Upload, Library, Globe, Table2, Languages, ArrowLeftRight, Tags, StickyNote, Database, BookImage, BookA, BookOpen, Search, Cloud, type LucideIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { Screen } from "./import-dialog-types"

// AQU-832: title/hint/description are catalog keys, not English strings — this
// table is module-level, evaluated once before any I18nProvider exists, so it
// cannot call t() itself. OptionCard resolves each key at render time instead.
type ImportOption = {
  /** Screen to route to on select. Omitted for not-yet-available options. */
  id?: Screen
  titleKey: MessageKey
  /** Short qualifier shown in lighter weight after the title. */
  hintKey?: MessageKey
  descriptionKey: MessageKey
  icon: LucideIcon
  badge?: "beta" | "soon"
  disabled?: boolean
}

const POPULAR_OPTIONS: ImportOption[] = [
  { id: "upload", titleKey: "importExport.landing.upload.title", icon: Upload,
    descriptionKey: "importExport.landing.upload.description" },
  { id: "ebible", titleKey: "importExport.landing.ebible.title", hintKey: "importExport.landing.ebible.hint", icon: Library,
    descriptionKey: "importExport.landing.ebible.description" },
  { id: "helloao", titleKey: "importExport.landing.helloao.title", hintKey: "importExport.landing.helloao.hint", icon: Globe,
    descriptionKey: "importExport.landing.helloao.description" },
  { id: "spreadsheet", titleKey: "importExport.landing.spreadsheet.title", hintKey: "importExport.landing.spreadsheet.hint", icon: Table2, badge: "beta",
    descriptionKey: "importExport.landing.spreadsheet.description" },
]

const SPECIALIZED_OPTIONS: ImportOption[] = [
  { id: "macula", titleKey: "importExport.landing.macula.title", icon: Languages, badge: "beta",
    descriptionKey: "importExport.landing.macula.description" },
  { id: "paired", titleKey: "importExport.landing.paired.title", icon: ArrowLeftRight, badge: "beta",
    descriptionKey: "importExport.landing.paired.description" },
  { id: "labels", titleKey: "importExport.landing.labels.title", icon: Tags, badge: "beta",
    descriptionKey: "importExport.landing.labels.description" },
  { id: "tn", titleKey: "importExport.landing.tn.title", hintKey: "importExport.landing.tn.hint", icon: StickyNote, badge: "beta",
    descriptionKey: "importExport.landing.tn.description" },
  { id: "biblica", titleKey: "importExport.landing.biblica.title", hintKey: "importExport.landing.biblica.hint", icon: BookOpen, badge: "beta",
    descriptionKey: "importExport.landing.biblica.description" },
  { id: "obs", titleKey: "importExport.landing.obs.title", hintKey: "importExport.landing.obs.hint", icon: BookImage, badge: "beta",
    descriptionKey: "importExport.landing.obs.description" },
  { id: "dcs", titleKey: "importExport.landing.dcs.title", hintKey: "importExport.landing.dcs.hint", icon: Cloud, badge: "beta",
    descriptionKey: "importExport.landing.dcs.description" },
  { id: "sdbh", titleKey: "importExport.landing.sdbh.title", hintKey: "importExport.landing.sdbh.hint", icon: BookA, badge: "beta",
    descriptionKey: "importExport.landing.sdbh.description" },
  { id: "upload", titleKey: "importExport.landing.tm.title", hintKey: "importExport.landing.tm.hint", icon: Database,
    descriptionKey: "importExport.landing.tm.description" },
]

function OptionBadge({ kind }: { kind: "beta" | "soon" }) {
  const t = useT()
  if (kind === "soon") {
    return <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">{t("importExport.landing.badgeSoon")}</Badge>
  }
  return (
    <Badge
      variant="secondary"
      className="border border-amber-200 bg-amber-100 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-400"
    >
      {t("importExport.landing.badgeBeta")}
    </Badge>
  )
}

function OptionCard({ option, onSelect }: { option: ImportOption; onSelect: (s: Screen) => void }) {
  const t = useT()
  const { icon: Icon, disabled } = option
  const title = t(option.titleKey)
  const select = () => { if (!disabled && option.id) onSelect(option.id) }
  const disabledTooltip = disabled
    ? t("importExport.landing.comingSoonTooltip", { title })
    : undefined
  const testTooltipAttr = import.meta.env.MODE === "test" ? disabledTooltip : undefined
  const card = (
    <Card
      size="sm"
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      data-tooltip={testTooltipAttr}
      onClick={select}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select() }
      }}
      className={cn(
        "gap-0 px-3",
        disabled
          ? "cursor-not-allowed opacity-55"
          : "transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium leading-none">{title}</span>
            {option.hintKey && <span className="text-xs text-muted-foreground">{t(option.hintKey)}</span>}
            {option.badge && <span className="ms-auto shrink-0"><OptionBadge kind={option.badge} /></span>}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t(option.descriptionKey)}</p>
        </div>
      </div>
    </Card>
  )

  if (!disabled) return card

  return <AppTooltip content={disabledTooltip}>{card}</AppTooltip>
}

function ImportSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="px-0.5 text-xs font-medium text-muted-foreground/70">{label}</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>
    </div>
  )
}

interface ImportLandingProps {
  onSelect: (screen: Screen) => void
  /** When false, the Door43 (DCS) option is hidden — its import needs a way to
   *  write the project settings cursor (patchDcsCursor), unavailable e.g. for
   *  unsynced local-only projects. */
  allowDcs: boolean
}

export function ImportLanding({ onSelect, allowDcs }: ImportLandingProps) {
  const t = useT()
  // The specialized tier is a growing catalogue of domain-specific importers —
  // filterable so it stays scannable as entries accumulate.
  const [filter, setFilter] = useState("")
  const q = filter.trim().toLowerCase()
  // Hide DCS when the host can't persist the release cursor.
  const available = allowDcs
    ? SPECIALIZED_OPTIONS
    : SPECIALIZED_OPTIONS.filter((o) => o.id !== "dcs")
  const specialized = q
    ? available.filter((o) =>
        [t(o.titleKey), o.hintKey ? t(o.hintKey) : "", t(o.descriptionKey)].some((s) => s.toLowerCase().includes(q)),
      )
    : available
  return (
    <div className="space-y-5 py-1">
      <p className="text-sm text-muted-foreground">{t("importExport.landing.intro")}</p>
      <ImportSection label={t("importExport.landing.popularSection")}>
        {POPULAR_OPTIONS.map((o) => (
          <OptionCard key={o.titleKey} option={o} onSelect={onSelect} />
        ))}
      </ImportSection>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="px-0.5 text-xs font-medium text-muted-foreground/70">{t("importExport.landing.specializedSection")}</h3>
          <InputGroup className="h-7 w-44">
            <InputGroupAddon>
              <Search className="text-muted-foreground/60" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("importExport.landing.filterPlaceholder")}
              aria-label={t("importExport.landing.filterAriaLabel")}
              className="text-xs placeholder:text-muted-foreground/60"
            />
          </InputGroup>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {specialized.map((o) => (
            <OptionCard key={o.titleKey} option={o} onSelect={onSelect} />
          ))}
          {specialized.length === 0 && (
            <p className="col-span-full px-0.5 py-2 text-xs text-muted-foreground">
              {t("importExport.landing.noMatches", { filter })}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
