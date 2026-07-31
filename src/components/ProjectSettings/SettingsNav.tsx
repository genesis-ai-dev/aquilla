import { Search } from "lucide-react"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"

export interface SettingsSection {
  id: string
  label: string
  /** Optional sub-labels to include in search matching (field labels, etc.) */
  keywords?: string[]
  /** Whether this section should be shown at all (e.g. Git Sync is conditional) */
  visible?: boolean
}

interface SettingsNavProps {
  onSearch: (query: string) => void
  searchQuery: string
}

/**
 * AQU-501: Project Settings' search box. Used to be paired with a flat,
 * scroll-spy-highlighted list of every section (one long scrolling page) —
 * that list is gone now that ProjectSettings.tsx groups sections into
 * sub-menu panes (see SETTINGS_GROUPS there) and renders its own NavList /
 * pane content. This component is just the search input; typing a query
 * still filters `ALL_SECTIONS` across every group (ProjectSettings.tsx does
 * the filtering and renders matches directly).
 */
export function SettingsNav({ onSearch, searchQuery }: SettingsNavProps) {
  return (
    <InputGroup className="h-8 bg-card">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        value={searchQuery}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search settings…"
        className="text-xs"
        aria-label="Search settings"
      />
    </InputGroup>
  )
}
