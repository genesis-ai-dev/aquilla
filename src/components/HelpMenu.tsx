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
import { useT } from "@/lib/i18n/I18nProvider"

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

/** Match NavHistoryControls recent-item row height (px-2 py-1.5, gap-2). */
const HELP_ITEM_CLASS = "gap-2 px-2 py-1.5 text-sm"

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
  const t = useT()
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
              aria-label={t("nav.help.menuLabel")}
              className={cn(
                // Match OrgSidebar nav links: text-sm + px-2 py-1.5 + size-4 icon.
                "flex items-center gap-2 rounded-md text-sm font-normal text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground",
                compact ? "size-8 justify-center" : "w-full px-2 py-1.5",
              )}
            />
          }
        >
          <HelpCircle className="size-4 shrink-0" aria-hidden />
          {!compact && (
            <>
              {t("nav.help.menuLabel")}
              {/* AQU-699: advertise that the trigger expands, so the Tour housed
                  inside it stays discoverable. Omitted when collapsed to an icon. */}
              <ChevronDown
                className="ml-auto size-4 opacity-50"
                aria-hidden
              />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className={cn("rounded-lg text-sm", compact ? "w-56" : "w-(--anchor-width)")}
          side="top"
          align={compact ? "end" : "start"}
          sideOffset={4}
        >
          <DropdownMenuGroup>
            {showTour ? (
              <DropdownMenuItem onClick={handleTour} className={HELP_ITEM_CLASS}>
                <Map />
                {t("nav.help.tour")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              className={HELP_ITEM_CLASS}
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
              className={HELP_ITEM_CLASS}
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
              {t("nav.help.docs")}
              <ExternalLink className="ml-auto opacity-60" />
            </DropdownMenuItem>
            <DropdownMenuItem
              className={HELP_ITEM_CLASS}
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
              {t("nav.help.discord")}
              <ExternalLink className="ml-auto opacity-60" />
            </DropdownMenuItem>
            <DropdownMenuItem
              className={HELP_ITEM_CLASS}
              render={
                <a href={`mailto:${SUPPORT_EMAIL}`} onClick={() => setOpen(false)} />
              }
            >
              <Mail />
              {t("nav.help.contactSupport")}
              <ExternalLink className="ml-auto opacity-60" />
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleReport} className={HELP_ITEM_CLASS}>
              <Flag />
              {t("nav.help.report")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ReportProblemDialog open={reportOpen} onOpenChange={setReportOpen} />
    </>
  )
}
