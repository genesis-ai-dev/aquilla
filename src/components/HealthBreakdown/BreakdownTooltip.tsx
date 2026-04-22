import type { CellHealthBreakdown } from "@/lib/parsers/types"

interface Props {
  breakdown: CellHealthBreakdown
}

const LABELS: Record<keyof Pick<CellHealthBreakdown, "validationGap" | "ancestryPenalty" | "neighborhoodPenalty" | "rulePenalty">, string> = {
  validationGap: "Reviewed",
  ancestryPenalty: "Examples",
  neighborhoodPenalty: "Consistency",
  rulePenalty: "Rules",
}

export function BreakdownTooltip({ breakdown }: Props) {
  const rows: Array<[string, number]> = [
    [LABELS.validationGap, -breakdown.validationGap],
    [LABELS.ancestryPenalty, -breakdown.ancestryPenalty],
    [LABELS.neighborhoodPenalty, -breakdown.neighborhoodPenalty],
    [LABELS.rulePenalty, -breakdown.rulePenalty],
  ]

  return (
    <div className="min-w-[180px] font-mono text-xs">
      <div className="mb-2 text-center text-2xl font-sans font-semibold">{breakdown.score}</div>
      <div className="space-y-0.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <span className="text-muted-foreground">{label}</span>
            <span className={value < 0 ? "text-destructive" : "text-foreground"}>
              {value === 0 ? "0" : value > 0 ? `+${value}` : `${value}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
