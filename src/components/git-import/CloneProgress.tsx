import { Loader2 } from "lucide-react"

interface Props {
  phase: "clone" | "parse" | "persist"
  done: number
  total: number
  label: string
}

export function CloneProgress({ phase, done, total, label }: Props) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const phaseLabel = { clone: "Cloning", parse: "Parsing files", persist: "Saving" }[phase]
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="text-sm font-medium">{phaseLabel}</span>
        <span className="text-xs text-muted-foreground truncate">{label}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {done} / {total}
      </p>
    </div>
  )
}
