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
 * AQU-501: Project Settings search box. Search filters across every settings
 * group on the index (and during search results). Detail panes intentionally
 * omit it — matching org settings / Preferences (no search bar on detail).
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
