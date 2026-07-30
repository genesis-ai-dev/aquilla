import { useMemo, useState } from "react"
import { ChevronDown, ChevronLeft, ChevronRight, CornerDownRight } from "lucide-react"
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
  subsections?: readonly MilestoneNavigationSubsection[]
}

export interface MilestoneNavigationSubsection {
  key: string
  label: string
  firstCellId: string
  translated: number
  validated: number
  total: number
}

export function milestoneMatchesSearch(item: MilestoneNavigationItem, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true

  if (/^\d+(?:[-–]\d+)?$/.test(normalizedQuery)) {
    const normalizedNumericQuery = normalizedQuery.replace("–", "-")
    return [
      item.shortLabel,
      ...(item.subsections?.map((subsection) => subsection.label) ?? []),
    ].some((label) => label.toLocaleLowerCase().replace("–", "-") === normalizedNumericQuery)
  }

  return `${item.label} ${item.shortLabel} ${item.description} ${
    item.subsections?.map((subsection) => subsection.label).join(" ") ?? ""
  }`
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

function isScriptureMilestone(kind: ImportMilestoneKind): boolean {
  return kind === "chapter" || kind === "chapter-range" || kind === "preface"
}

export function MilestoneNavigator({
  items,
  activeKey,
  activeSubsectionKey,
  onSelect,
}: {
  items: MilestoneNavigationItem[]
  activeKey: string
  activeSubsectionKey?: string
  onSelect: (key: string, subsectionKey?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [expandedKey, setExpandedKey] = useState(activeKey)
  const vocabulary = useMemo(() => vocabularyFor(items), [items])
  const scriptureNavigation = items.every((item) => isScriptureMilestone(item.kind))
  const matchedActiveIndex = items.findIndex((item) => item.key === activeKey)
  const activeIndex = matchedActiveIndex >= 0 ? matchedActiveIndex : 0
  const active = items[activeIndex]
  const activeSubsection = active?.subsections?.find(
    (subsection) => subsection.key === activeSubsectionKey,
  ) ?? active?.subsections?.[0]
  const destinations = useMemo<{ milestoneKey: string; subsectionKey?: string }[]>(
    () => items.flatMap((item) => (
    item.subsections?.length
      ? item.subsections.map((subsection) => ({
          milestoneKey: item.key,
          subsectionKey: subsection.key,
        }))
      : [{ milestoneKey: item.key }]
    )),
    [items],
  )
  const activeDestinationIndex = destinations.findIndex((destination) => (
    destination.milestoneKey === active?.key
    && (
      destination.subsectionKey === activeSubsection?.key
      || (!destination.subsectionKey && !activeSubsection)
    )
  ))
  const canGoPrevious = activeDestinationIndex > 0
  const canGoNext = activeDestinationIndex >= 0 && activeDestinationIndex < destinations.length - 1
  const filteredItems = useMemo(
    () => items.filter((item) => milestoneMatchesSearch(item, search)),
    [items, search],
  )

  if (!active || items.length === 0) return null

  const choose = (key: string, subsectionKey?: string) => {
    if (subsectionKey) onSelect(key, subsectionKey)
    else onSelect(key)
    setOpen(false)
    setSearch("")
  }

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) setExpandedKey(active.key)
    else setSearch("")
  }

  return (
    <nav aria-label="Milestone navigation" className="flex items-center justify-center">
      <ButtonGroup aria-label={`Move between ${vocabulary.plural.toLocaleLowerCase()}`} className="shadow-xs">
        <Button
          variant="outline"
          size="icon"
          disabled={!canGoPrevious}
          aria-label={`Previous ${vocabulary.singular}`}
          onClick={() => {
            const destination = destinations[activeDestinationIndex - 1]
            if (destination) choose(destination.milestoneKey, destination.subsectionKey)
          }}
        >
          <ChevronLeft />
        </Button>
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                className="grid min-w-56 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2"
                aria-label={`Current ${vocabulary.singular}: ${active.label}${
                  activeSubsection ? `, cells ${activeSubsection.label}` : ""
                }. Choose ${vocabulary.singular}`}
              />
            }
          >
            <span className="truncate text-left font-semibold">{active.label}</span>
            <span className="justify-self-center text-xs font-normal text-muted-foreground">
              {activeSubsection ? `(${activeSubsection.label})` : active.description}
            </span>
            <ChevronDown data-icon="inline-end" className="justify-self-end" />
          </PopoverTrigger>
          <PopoverContent
            align="center"
            className="w-[min(24rem,calc(100vw-1rem))] gap-0 overflow-hidden p-0"
          >
            <PopoverHeader className="px-4 py-3">
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
                    const expanded = expandedKey === item.key
                    const translatedPercent = item.total > 0
                      ? Math.round((item.translated / item.total) * 100)
                      : 0
                    const validatedPercent = item.total > 0
                      ? Math.round((item.validated / item.total) * 100)
                      : 0
                    return (
                      <div key={item.key}>
                        <CommandItem
                          value={`${item.label} ${item.shortLabel}`}
                          data-checked={selected || undefined}
                          onSelect={() => {
                            if (item.subsections?.length) {
                              setExpandedKey(expanded ? "" : item.key)
                            } else {
                              choose(item.key)
                            }
                          }}
                          className="grid min-h-12 grid-cols-[minmax(0,1fr)_7.5rem_1rem] items-center gap-3 px-3"
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            {!scriptureNavigation ? (
                              <Badge
                                variant={selected ? "default" : "outline"}
                                className="w-10 shrink-0 justify-center overflow-hidden rounded-full px-1.5 tabular-nums"
                                aria-hidden="true"
                                data-milestone-badge
                              >
                                {item.shortLabel}
                              </Badge>
                            ) : null}
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{item.label}</span>
                              <span className="block text-xs text-muted-foreground">
                                {item.description}
                              </span>
                            </span>
                          </span>
                          <span className="w-[7.5rem] justify-self-end text-right text-xs tabular-nums text-muted-foreground">
                            <span className="block">{translatedPercent}% translated</span>
                            <span className="block">{validatedPercent}% validated</span>
                          </span>
                        </CommandItem>
                        {expanded && item.subsections?.length ? (
                          <div
                            data-milestone-subsections
                            className="space-y-0.5 px-2 pb-1 pl-6"
                          >
                            {item.subsections.map((subsection) => {
                              const subsectionSelected = selected && subsection.key === activeSubsection?.key
                              const subsectionTranslatedPercent = subsection.total > 0
                                ? Math.round((subsection.translated / subsection.total) * 100)
                                : 0
                              const subsectionValidatedPercent = subsection.total > 0
                                ? Math.round((subsection.validated / subsection.total) * 100)
                                : 0
                              return (
                                <CommandItem
                                  key={subsection.key}
                                  value={`${item.label} ${subsection.label}`}
                                  data-milestone-subsection
                                  data-checked={subsectionSelected || undefined}
                                  onSelect={() => choose(item.key, subsection.key)}
                                  className="grid min-h-9 grid-cols-[minmax(0,1fr)_7.5rem_1rem] items-center gap-3 rounded-md px-3"
                                >
                                  <span className="flex min-w-0 items-center gap-2 text-xs font-medium tabular-nums">
                                    <CornerDownRight
                                      aria-hidden="true"
                                      className="size-3.5 shrink-0 text-muted-foreground"
                                    />
                                    <span className="truncate">Cells {subsection.label}</span>
                                  </span>
                                  <span className="w-[7.5rem] justify-self-end text-right text-xs tabular-nums text-muted-foreground">
                                    <span className="block">{subsectionTranslatedPercent}% translated</span>
                                    <span className="block">{subsectionValidatedPercent}% validated</span>
                                  </span>
                                </CommandItem>
                              )
                            })}
                          </div>
                        ) : null}
                      </div>
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
          onClick={() => {
            const destination = destinations[activeDestinationIndex + 1]
            if (destination) choose(destination.milestoneKey, destination.subsectionKey)
          }}
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
