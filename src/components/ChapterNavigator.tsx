import { useMemo, useState } from "react"
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import type { ImportMilestoneKind } from "../../shared/import-contract"

export interface MilestoneNavigationItem {
  key: string
  kind: ImportMilestoneKind
  label: string
  shortLabel: string
  description: string
  translated: number
  validated: number
  total: number
}

export function milestoneMatchesSearch(item: MilestoneNavigationItem, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true

  if (/^\d+(?:[-–]\d+)?$/.test(normalizedQuery)) {
    return item.shortLabel.toLocaleLowerCase().replace("–", "-")
      === normalizedQuery.replace("–", "-")
  }

  return `${item.label} ${item.shortLabel} ${item.description}`
    .toLocaleLowerCase()
    .includes(normalizedQuery)
}

interface NavigationVocabulary {
  singular: string
  plural: string
  description: string
}

function vocabularyFor(items: readonly MilestoneNavigationItem[]): NavigationVocabulary {
  const kinds = new Set(items.map((item) => item.kind))
  if ([...kinds].every((kind) => (
    kind === "chapter" || kind === "chapter-range" || kind === "preface"
  ))) {
    return {
      singular: "chapter",
      plural: "Chapters",
      description: "Choose a chapter or passage range to jump to its first cell.",
    }
  }
  if (kinds.size === 1 && kinds.has("slide")) {
    return { singular: "slide", plural: "Slides", description: "Choose a slide to jump to its first cell." }
  }
  if (kinds.size === 1 && kinds.has("story")) {
    return { singular: "story", plural: "Stories", description: "Choose a story to jump to its first frame." }
  }
  if (kinds.size === 1 && kinds.has("section")) {
    return { singular: "section", plural: "Sections", description: "Choose a section to jump to its heading." }
  }
  if (kinds.size === 1 && kinds.has("time-range")) {
    return { singular: "time range", plural: "Time ranges", description: "Choose a time range to jump to its first segment." }
  }
  if (kinds.size === 1 && kinds.has("part")) {
    return { singular: "part", plural: "Parts", description: "Choose a part to jump to its first cell." }
  }
  if (kinds.size === 1 && kinds.has("group")) {
    return { singular: "group", plural: "Groups", description: "Choose a group to jump to its first cell." }
  }
  return { singular: "milestone", plural: "Milestones", description: "Choose a milestone to jump to its first cell." }
}

export function MilestoneNavigator({
  items,
  activeKey,
  onSelect,
}: {
  items: MilestoneNavigationItem[]
  activeKey: string
  onSelect: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const vocabulary = useMemo(() => vocabularyFor(items), [items])
  const matchedActiveIndex = items.findIndex((item) => item.key === activeKey)
  const activeIndex = matchedActiveIndex >= 0 ? matchedActiveIndex : 0
  const active = items[activeIndex]
  const canGoPrevious = activeIndex > 0
  const canGoNext = activeIndex >= 0 && activeIndex < items.length - 1
  const filteredItems = useMemo(
    () => items.filter((item) => milestoneMatchesSearch(item, search)),
    [items, search],
  )

  if (!active || items.length === 0) return null

  const choose = (key: string) => {
    onSelect(key)
    setOpen(false)
    setSearch("")
  }

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) setSearch("")
  }

  return (
    <nav aria-label="Milestone navigation" className="flex items-center justify-center">
      <ButtonGroup aria-label={`Move between ${vocabulary.plural.toLocaleLowerCase()}`} className="shadow-xs">
        <Button
          variant="outline"
          size="icon"
          disabled={!canGoPrevious}
          aria-label={`Previous ${vocabulary.singular}`}
          onClick={() => choose(items[activeIndex - 1].key)}
        >
          <ChevronLeft />
        </Button>
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                className="grid min-w-56 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2"
                aria-label={`Current ${vocabulary.singular}: ${active.label}. Choose ${vocabulary.singular}`}
              />
            }
          >
            <span className="truncate text-left font-semibold">{active.label}</span>
            <span className="justify-self-center text-xs font-normal text-muted-foreground">
              {active.description}
            </span>
            <ChevronDown data-icon="inline-end" className="justify-self-end" />
          </PopoverTrigger>
          <PopoverContent align="center" className="w-80 gap-0 overflow-hidden p-0">
            <PopoverHeader className="px-3 py-2.5">
              <PopoverTitle>Go to {vocabulary.singular}</PopoverTitle>
              <PopoverDescription>{vocabulary.description}</PopoverDescription>
            </PopoverHeader>
            <Separator />
            <Command label={`Find a ${vocabulary.singular}`} className="rounded-none! p-1" shouldFilter={false}>
              <CommandInput
                placeholder={`Find a ${vocabulary.singular}…`}
                value={search}
                onValueChange={setSearch}
              />
              <CommandList>
                <CommandEmpty>No {vocabulary.plural.toLocaleLowerCase()} found.</CommandEmpty>
                <CommandGroup heading={vocabulary.plural}>
                  {filteredItems.map((item) => {
                    const selected = item.key === active.key
                    const translatedPercent = item.total > 0
                      ? Math.round((item.translated / item.total) * 100)
                      : 0
                    const validatedPercent = item.total > 0
                      ? Math.round((item.validated / item.total) * 100)
                      : 0
                    return (
                      <CommandItem
                        key={item.key}
                        value={`${item.label} ${item.shortLabel}`}
                        data-checked={selected || undefined}
                        onSelect={() => choose(item.key)}
                        className="min-h-11"
                      >
                        <Badge
                          variant={selected ? "default" : "outline"}
                          className="min-w-6 rounded-full px-1.5 tabular-nums"
                          aria-hidden="true"
                        >
                          {item.shortLabel}
                        </Badge>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{item.label}</span>
                          <span className="block text-xs text-muted-foreground">
                            {item.description}
                          </span>
                        </span>
                        <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          <span className="block">{translatedPercent}% translated</span>
                          <span className="block">{validatedPercent}% validated</span>
                        </span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button
          variant="outline"
          size="icon"
          disabled={!canGoNext}
          aria-label={`Next ${vocabulary.singular}`}
          onClick={() => choose(items[activeIndex + 1].key)}
        >
          <ChevronRight />
        </Button>
      </ButtonGroup>
    </nav>
  )
}

/** Compatibility exports for older call sites/tests while the surface remains
 * in the historic ChapterNavigator module. */
export type ChapterNavigationItem = MilestoneNavigationItem
export const chapterMatchesSearch = milestoneMatchesSearch
export const ChapterNavigator = MilestoneNavigator
