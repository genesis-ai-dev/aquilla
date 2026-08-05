import { useCallback, useState } from "react"
import { HelpCircle, ExternalLink, Mail, BookOpen, Map, Flag, ChevronDown, Home } from "lucide-react"
import { Discord } from "@/components/icons/Discord"
import { cn } from "@/lib/utils"
import { useProductTourContext } from "@/context/ProductTourContext"
import { ReportProblemDialog } from "@/components/ReportProblemButton/ReportProblemDialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// Configured at build time with sane defaults so help links always work.
const DOCS_URL =
  (import.meta.env.VITE_DOCS_URL as string | undefined)?.trim() ||
  "https://help.aquilla.app"
const DISCORD_URL =
  (import.meta.env.VITE_DISCORD_INVITE_URL as string | undefined)?.trim() ||
  "https://discord.gg/T2EndwXe4W"
const SUPPORT_EMAIL =
  (import.meta.env.VITE_SUPPORT_EMAIL as string | undefined)?.trim() ||
  "support@aquilla.app"

interface HelpMenuProps {
  /** Icon-only trigger for the collapsed dock rail. */
  compact?: boolean
  /** Org-level tour entry; hidden in the project editor dock. */
  showTour?: boolean
}

/**
 * Global help + community affordance. Docs, community, contact, and report
 * (AQU-307) live here so the left rail stays uncluttered.
 */
export function HelpMenu({ compact = false, showTour = true }: HelpMenuProps) {
  const [open, setOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const { openTour } = useProductTourContext()

  const handleTour = useCallback(() => {
    setOpen(false)
    openTour()
  }, [openTour])

  const handleReport = useCallback(() => {
    setOpen(false)
    setReportOpen(true)
  }, [])

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Help & community"
              className={cn(
                "flex items-center gap-2 rounded-md text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground data-popup-open:bg-accent/60 data-popup-open:text-foreground",
                compact ? "size-8 justify-center" : "w-full px-2 py-1.5",
              )}
            />
          }
        >
          <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {!compact && (
            <>
              Help &amp; community
              {/* AQU-699: advertise that the trigger expands, so the Tour housed
                  inside it stays discoverable. Omitted when collapsed to an icon. */}
              <ChevronDown
                className="ml-auto h-3.5 w-3.5 opacity-50"
                aria-hidden
              />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className={cn("rounded-lg", compact ? "w-56" : "w-(--anchor-width)")}
          side="top"
          align="start"
          sideOffset={4}
        >
          <DropdownMenuGroup>
            {showTour ? (
              <DropdownMenuItem onClick={handleTour}>
                <Map />
                Take the tour
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              render={
                // Hard <a>: /homepage is the separate marketing entry point.
                <a
                  href="/homepage"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                />
              }
            >
              <Home />
              Homepage
              <ExternalLink className="ml-auto opacity-60" />
            </DropdownMenuItem>
            <DropdownMenuItem
              render={
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                />
              }
            >
              <BookOpen />
              Help
              <ExternalLink className="ml-auto opacity-60" />
            </DropdownMenuItem>
            <DropdownMenuItem
              render={
                <a
                  href={DISCORD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                />
              }
            >
              <Discord className="size-4 shrink-0" />
              Discord server
              <ExternalLink className="ml-auto opacity-60" />
            </DropdownMenuItem>
            <DropdownMenuItem
              render={
                <a href={`mailto:${SUPPORT_EMAIL}`} onClick={() => setOpen(false)} />
              }
            >
              <Mail />
              Contact support
              <ExternalLink className="ml-auto opacity-60" />
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleReport}>
              <Flag />
              Report
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ReportProblemDialog open={reportOpen} onOpenChange={setReportOpen} />
    </>
  )
}
