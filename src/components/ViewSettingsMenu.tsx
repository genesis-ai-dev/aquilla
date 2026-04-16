import { useEffect, useState } from "react"
import { Menu } from "@base-ui/react/menu"
import { Eye } from "lucide-react"
import { Button } from "@/components/ui/button"

interface ViewSettingsMenuProps {
  fileOpen: boolean
  lineNumbersEnabled: boolean
  textDirection: "ltr" | "rtl"
  cellLabelsEnabled: boolean
  onLineNumbersChange: (v: boolean) => void
  onTextDirectionChange: (v: "ltr" | "rtl") => void
  onCellLabelsChange: (v: boolean) => void
}

export function ViewSettingsMenu({
  fileOpen,
  lineNumbersEnabled,
  textDirection,
  cellLabelsEnabled,
  onLineNumbersChange,
  onTextDirectionChange,
  onCellLabelsChange,
}: ViewSettingsMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button variant="ghost" size="sm" title="View settings">
            <Eye className="h-4 w-4" />
          </Button>
        }
      />
      <Menu.Portal>
        <Menu.Positioner sideOffset={4}>
          <Menu.Popup className="z-50 min-w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
            <Menu.Item
              disabled={!fileOpen}
              onClick={() => onLineNumbersChange(!lineNumbersEnabled)}
              className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
            >
              <span>Show line numbers</span>
              <Pill on={lineNumbersEnabled} />
            </Menu.Item>
            <Menu.Item
              onClick={() => onCellLabelsChange(!cellLabelsEnabled)}
              className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
            >
              <span>Show cell labels</span>
              <Pill on={cellLabelsEnabled} />
            </Menu.Item>
            <div className="-mx-1 my-1 h-px bg-border" role="separator" />
            <Menu.Item
              disabled={!fileOpen}
              onClick={() => onTextDirectionChange(textDirection === "ltr" ? "rtl" : "ltr")}
              className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
            >
              <span>Text Direction</span>
              <span className="text-xs text-muted-foreground">{textDirection.toUpperCase()}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function Pill({ on }: { on: boolean }) {
  return (
    <span
      className={
        "rounded-full px-2 py-0.5 text-[10px] font-medium " +
        (on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")
      }
    >
      {on ? "On" : "Off"}
    </span>
  )
}

const STORAGE_KEY = "codex:cellLabelsEnabled:"

export function useCellLabelsPreference(projectId: string): [boolean, (v: boolean) => void] {
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY + projectId)
    setEnabled(raw === null ? true : raw === "true")
  }, [projectId])

  const setAndPersist = (v: boolean) => {
    setEnabled(v)
    localStorage.setItem(STORAGE_KEY + projectId, String(v))
  }

  return [enabled, setAndPersist]
}
