import type { ComponentType, ReactNode } from "react"
import { Menu } from "@base-ui/react/menu"
import { MoreHorizontal, X } from "lucide-react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ThemeToggle } from "@/branding/ThemeMode"
import { Button } from "@/components/ui/button"

export interface OverflowMenuItem {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  onClick: () => void
}

interface Props {
  project: ProjectRecord
  onBack: () => void
  children?: ReactNode
  extraMenuItems?: OverflowMenuItem[]
}

export function WorkspaceHeader({ project, onBack, children, extraMenuItems }: Props) {
  return (
    <header className="relative z-30 flex items-center gap-3 border-b bg-background px-4 py-2">
      <nav className="flex items-center gap-1 text-sm min-w-0">
        <button
          className="text-muted-foreground hover:text-foreground truncate"
          onClick={onBack}
        >
          Dashboard
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium truncate">{project.name}</span>
        {(project.sourceLanguage || project.targetLanguage) && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground truncate">
              {project.sourceLanguage || "?"} → {project.targetLanguage || "?"}
            </span>
          </>
        )}
      </nav>
      <div className="flex-1" />
      <div className="flex items-center gap-1 shrink-0">
        {children}
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button variant="ghost" size="icon" aria-label="More" title="More">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            }
          />
          <Menu.Portal>
            <Menu.Positioner sideOffset={4} align="end">
              <Menu.Popup className="z-40 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                <Menu.Item
                  onClick={onBack}
                  className="flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
                >
                  <X className="h-4 w-4" />
                  <span>Close project</span>
                </Menu.Item>
                {extraMenuItems && extraMenuItems.length > 0 && (
                  <>
                    <div className="my-1 h-px bg-border" role="separator" />
                    {extraMenuItems.map((item) => (
                      <Menu.Item
                        key={item.id}
                        onClick={item.onClick}
                        className="flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
                      >
                        <item.icon className="h-4 w-4" />
                        <span>{item.label}</span>
                      </Menu.Item>
                    ))}
                  </>
                )}
                <div className="my-1 h-px bg-border" role="separator" />
                <div className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
                  <span className="text-muted-foreground">Theme</span>
                  <ThemeToggle />
                </div>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
    </header>
  )
}
