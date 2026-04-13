import type { CellData } from "@/hooks/useCells"

interface StatusBarProps {
  cells: CellData[]
}

export function StatusBar({ cells }: StatusBarProps) {
  const total = cells.length
  const translated = cells.filter((c) => c.translated !== c.original).length
  const percentage = total > 0 ? Math.round((translated / total) * 100) : 0

  return (
    <footer className="border-t px-4 py-1.5 text-sm text-muted-foreground">
      {total.toLocaleString()} cells · {translated.toLocaleString()} translated · {percentage}%
    </footer>
  )
}
