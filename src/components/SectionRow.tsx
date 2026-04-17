import { cn } from "@/lib/utils"

interface SectionRowProps {
  label: string
  translated: number
  validated: number
  total: number
  onClick: () => void
}

export function SectionRow({ label, translated, validated, total, onClick }: SectionRowProps) {
  const translatedPct = total > 0 ? Math.round((translated / total) * 100) : 0
  const validatedPct = total > 0 ? Math.round((validated / total) * 100) : 0
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1 pl-8 text-xs text-left",
        "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      onClick={onClick}
    >
      <span className="truncate flex-1">{label}</span>
      <div className="flex items-center gap-0.5 shrink-0" aria-label={`${translatedPct}% translated, ${validatedPct}% validated`}>
        <span className="h-2 w-8 rounded-full bg-muted overflow-hidden">
          <span className="block h-full bg-amber-500" style={{ width: `${translatedPct}%` }} />
        </span>
        <span className="h-2 w-8 rounded-full bg-muted overflow-hidden">
          <span className="block h-full bg-emerald-500" style={{ width: `${validatedPct}%` }} />
        </span>
      </div>
    </button>
  )
}
