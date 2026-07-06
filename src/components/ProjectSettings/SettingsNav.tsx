import { useEffect, useState } from "react"
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
  sections: SettingsSection[]
  activeId: string | null
  onSearch: (query: string) => void
  searchQuery: string
}

export function SettingsNav({ sections, activeId, onSearch, searchQuery }: SettingsNavProps) {
  const visibleSections = sections.filter((s) => s.visible !== false)

  function scrollTo(id: string) {
    const el = document.getElementById(id)
    if (!el) return
    // Offset by header height (~52px) + a little breathing room
    const top = el.getBoundingClientRect().top + window.scrollY - 64
    window.scrollTo({ top, behavior: "smooth" })
  }

  return (
    <nav className="flex flex-col gap-1" aria-label="Settings sections">
      <InputGroup className="mb-2 h-8">
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
      {visibleSections.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => scrollTo(s.id)}
          className={[
            "w-full rounded px-2 py-1.5 text-left text-sm transition-colors",
            activeId === s.id
              ? "bg-accent text-accent-foreground font-medium"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          ].join(" ")}
        >
          {s.label}
        </button>
      ))}
      {visibleSections.length === 0 && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching sections</p>
      )}
    </nav>
  )
}

/** Hook: returns the id of whichever registered section is nearest to the top of the viewport. */
export function useScrollSpy(ids: string[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null)

  useEffect(() => {
    function onScroll() {
      const OFFSET = 80 // px below top of viewport to consider "active"
      let current: string | null = null
      for (const id of ids) {
        const el = document.getElementById(id)
        if (!el) continue
        const top = el.getBoundingClientRect().top
        if (top <= OFFSET) current = id
      }
      setActiveId(current ?? ids[0] ?? null)
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener("scroll", onScroll)
  }, [ids.join(",")])  // eslint-disable-line react-hooks/exhaustive-deps

  return activeId
}
