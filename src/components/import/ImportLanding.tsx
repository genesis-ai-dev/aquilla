import { useState, type ReactNode } from "react"
import { Upload, Library, Globe, Table2, Languages, ArrowLeftRight, Tags, StickyNote, Database, BookImage, BookA, BookOpen, Search, Cloud, type LucideIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { Screen } from "./import-dialog-types"

type ImportOption = {
  /** Screen to route to on select. Omitted for not-yet-available options. */
  id?: Screen
  title: string
  /** Short qualifier shown in lighter weight after the title. */
  hint?: string
  description: string
  icon: LucideIcon
  badge?: "beta" | "soon"
  disabled?: boolean
}

const POPULAR_OPTIONS: ImportOption[] = [
  { id: "upload", title: "Upload files", icon: Upload,
    description: "USFM, DOCX, PPTX, IDML, TXT, subtitles, spreadsheets, audio/video, or a Paratext project." },
  { id: "ebible", title: "eBible Corpus", hint: "public library", icon: Library,
    description: "Openly-licensed Bible translations, imported directly — no download." },
  { id: "helloao", title: "Bible API", hint: "helloao.org", icon: Globe,
    description: "1,000+ translations — the whole Bible, one testament, or just the books you pick." },
  { id: "spreadsheet", title: "Spreadsheet", hint: "CSV / XLSX", icon: Table2, badge: "beta",
    description: "Map which columns are source, target, label, cast, or timestamp." },
]

const SPECIALIZED_OPTIONS: ImportOption[] = [
  { id: "macula", title: "Macula Hebrew + Greek", icon: Languages, badge: "beta",
    description: "Original-language OT/NT with per-word lemma, morphology, and Strong's." },
  { id: "paired", title: "Paired translation", icon: ArrowLeftRight, badge: "beta",
    description: "Source + target pairs from a spreadsheet to fill the target column." },
  { id: "labels", title: "Cell labels / cast", icon: Tags, badge: "beta",
    description: "Re-upload a template to label existing cells with cast names." },
  { id: "tn", title: "Translation Notes", hint: "TSV", icon: StickyNote, badge: "beta",
    description: "unfoldingWord notes, shown beside the matching verse as you translate." },
  { id: "biblica", title: "Biblica Study Bible Notes", hint: "IDML", icon: BookOpen, badge: "beta",
    description: "Study notes from an InDesign study Bible — imports the notes only and leaves the scripture untouched." },
  { id: "obs", title: "Open Bible Stories", hint: "door43", icon: BookImage, badge: "beta",
    description: "Narrative stories with reference images, from unfoldingWord/door43." },
  { id: "dcs", title: "Door43 (DCS)", hint: "upstream", icon: Cloud, badge: "beta",
    description: "Import any released Door43 resource as source and pin it to a release — pull upstream changes later." },
  { id: "sdbh", title: "SDBH Hebrew Lexicon", hint: "UBS MARBLE", icon: BookA, badge: "beta",
    description: "Semantic Dictionary of Biblical Hebrew — localize definitions and glosses by semantic domain, with lossless export back to the MARBLE XML." },
  { id: "upload", title: "Translation Memory", hint: "TMX", icon: Database,
    description: "Import source/target pairs from a TMX memory file." },
]

function OptionBadge({ kind }: { kind: "beta" | "soon" }) {
  if (kind === "soon") {
    return <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">Soon</Badge>
  }
  return (
    <Badge
      variant="secondary"
      className="border border-amber-200 bg-amber-100 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-400"
    >
      Beta
    </Badge>
  )
}

function OptionCard({ option, onSelect }: { option: ImportOption; onSelect: (s: Screen) => void }) {
  const { icon: Icon, disabled } = option
  const select = () => { if (!disabled && option.id) onSelect(option.id) }
  const disabledTooltip = disabled
    ? `Coming soon — ${option.title} import is tracked for a later release`
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
            <span className="text-sm font-medium leading-none">{option.title}</span>
            {option.hint && <span className="text-xs text-muted-foreground">{option.hint}</span>}
            {option.badge && <span className="ms-auto shrink-0"><OptionBadge kind={option.badge} /></span>}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{option.description}</p>
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
        [o.title, o.hint ?? "", o.description].some((t) => t.toLowerCase().includes(q)),
      )
    : available
  return (
    <div className="space-y-5 py-1">
      <p className="text-sm text-muted-foreground">Choose the format that matches your files.</p>
      <ImportSection label="Most popular">
        {POPULAR_OPTIONS.map((o) => (
          <OptionCard key={o.title} option={o} onSelect={onSelect} />
        ))}
      </ImportSection>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="px-0.5 text-xs font-medium text-muted-foreground/70">Specialized</h3>
          <InputGroup className="h-7 w-44">
            <InputGroupAddon>
              <Search className="text-muted-foreground/60" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter importers…"
              aria-label="Filter specialized importers"
              className="text-xs placeholder:text-muted-foreground/60"
            />
          </InputGroup>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {specialized.map((o) => (
            <OptionCard key={o.title} option={o} onSelect={onSelect} />
          ))}
          {specialized.length === 0 && (
            <p className="col-span-full px-0.5 py-2 text-xs text-muted-foreground">
              No importer matches “{filter}”.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
