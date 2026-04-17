import { Search } from "lucide-react"

interface Props { onClick: () => void }

export function SidebarCommandPaletteHint({ onClick }: Props) {
  return (
    <button
      className="flex w-full items-center gap-2 border-t px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
      onClick={onClick}
    >
      <Search className="h-3.5 w-3.5" />
      <span className="flex-1 text-left">Search</span>
      <span className="rounded border px-1 text-[10px]">⌘K</span>
    </button>
  )
}
