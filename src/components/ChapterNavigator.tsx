import { useMemo, useState } from "react"
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
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
import { cn } from "@/lib/utils"

export interface ChapterNavigationItem {
  label: string
  displayLabel: string
  verseRange: string | null
  translated: number
  validated: number
  total: number
}

export function ChapterNavigator({
  chapters,
  activeLabel,
  onSelect,
}: {
  chapters: ChapterNavigationItem[]
  activeLabel: string
  onSelect: (label: string) => void
}) {
  const [open, setOpen] = useState(false)
  const matchedActiveIndex = chapters.findIndex((chapter) => chapter.label === activeLabel)
  const activeIndex = matchedActiveIndex >= 0 ? matchedActiveIndex : 0
  const active = chapters[activeIndex]
  const canGoPrevious = activeIndex > 0
  const canGoNext = activeIndex >= 0 && activeIndex < chapters.length - 1

  const activeSummary = useMemo(() => {
    if (!active) return ""
    return active.verseRange ? `Verses ${active.verseRange}` : `${active.total} cells`
  }, [active])

  if (!active || chapters.length === 0) return null

  const choose = (label: string) => {
    onSelect(label)
    setOpen(false)
  }

  return (
    <nav aria-label="Chapter navigation" className="flex items-center justify-center gap-2">
      <ButtonGroup aria-label="Move between chapters">
        <Button
          variant="outline"
          size="icon-sm"
          disabled={!canGoPrevious}
          aria-label="Previous chapter"
          onClick={() => choose(chapters[activeIndex - 1].label)}
        >
          <ChevronLeft />
        </Button>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                className="h-8 min-w-44 justify-between gap-3 px-3"
                aria-label={`Current chapter: ${active.displayLabel}. Choose chapter`}
              />
            }
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-semibold normal-case tracking-normal">{active.displayLabel}</span>
              <span className="shrink-0 text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
                {activeSummary}
              </span>
            </span>
            <ChevronDown data-icon="inline-end" />
          </PopoverTrigger>
          <PopoverContent align="center" className="w-80 p-1.5">
            <PopoverHeader className="px-2 pt-1.5">
              <PopoverTitle>Go to chapter</PopoverTitle>
              <PopoverDescription>Choose a chapter to jump to its first verse.</PopoverDescription>
            </PopoverHeader>
            <Command label="Find a chapter">
              <CommandInput placeholder="Find a chapter…" />
              <CommandList>
                <CommandEmpty>No chapters found.</CommandEmpty>
                <CommandGroup>
                  {chapters.map((chapter) => {
                    const selected = chapter.label === active.label
                    const translatedPercent = chapter.total > 0
                      ? Math.round((chapter.translated / chapter.total) * 100)
                      : 0
                    return (
                      <CommandItem
                        key={chapter.label}
                        value={`${chapter.displayLabel} ${chapter.label}`}
                        data-checked={selected || undefined}
                        onSelect={() => choose(chapter.label)}
                        className="min-h-11"
                      >
                        <span
                          className={cn(
                            "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums",
                            selected && "border-primary bg-primary text-primary-foreground",
                          )}
                          aria-hidden="true"
                        >
                          {chapter.displayLabel.match(/\d+$/)?.[0]}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{chapter.displayLabel}</span>
                          <span className="block text-xs text-muted-foreground">
                            {chapter.verseRange ? `Verses ${chapter.verseRange}` : `${chapter.total} cells`}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {translatedPercent}% translated
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
          size="icon-sm"
          disabled={!canGoNext}
          aria-label="Next chapter"
          onClick={() => choose(chapters[activeIndex + 1].label)}
        >
          <ChevronRight />
        </Button>
      </ButtonGroup>
    </nav>
  )
}
