import { useCallback, useState } from "react"
import { HelpCircle, ExternalLink, Mail, BookOpen, Map } from "lucide-react"
import { Discord } from "@/components/icons/Discord"
import { useProductTourContext } from "@/context/ProductTourContext"
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

/**
 * Global help + community affordance (the escape hatch the UX audit flagged as
 * missing). Feedback already has a home via ReportProblemButton; this adds docs,
 * community, and a way to contact a human.
 */
export function HelpMenu() {
  const [open, setOpen] = useState(false)
  const { openTour } = useProductTourContext()

  const handleTour = useCallback(() => {
    setOpen(false)
    openTour()
  }, [openTour])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground data-popup-open:bg-accent/60 data-popup-open:text-foreground"
          />
        }
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
        Help &amp; community
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-(--anchor-width) rounded-lg"
        side="top"
        align="start"
        sideOffset={4}
      >
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={handleTour}>
            <Map />
            Take the tour
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
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
