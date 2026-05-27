import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface ProjectNavItem {
  id: string
  label: string
  icon: LucideIcon
  badge?: number
  onClick: () => void
}

interface Props {
  items: ProjectNavItem[]
}

export function SidebarProjectSection({ items }: Props) {
  return (
    <div className="px-2 py-2">
      <div className="px-1 pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        Project
      </div>
      <div className="space-y-1">
        {items.map((item) => (
          <button
            key={item.id}
            className={cn(
              "flex w-full items-center gap-2 rounded-xl bg-card px-2 py-1.5 text-sm transition-shadow hover:shadow-neu-xs",
            )}
            onClick={item.onClick}
          >
            <item.icon className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 text-left">{item.label}</span>
            {item.badge != null && item.badge > 0 && (
              <span className="rounded-full px-1.5 text-[10px] text-primary shadow-neu-inset">{item.badge}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
