import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MessageCircleIcon } from "lucide-react"

const BETA_ENABLED = import.meta.env.VITE_BETA_FLAG === "1"

export function BetaBadge() {
  if (!BETA_ENABLED) return null

  return (
    <Dialog>
      <DialogTrigger
        render={
          <button type="button" className="cursor-pointer">
            <Badge>Beta</Badge>
          </button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Heads up — we're in beta</DialogTitle>
          <DialogDescription>
            Things might move around, break, or change without warning. That's
            the deal for now.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li>The UI is actively evolving</li>
          <li>Features may appear or disappear</li>
          <li>Your feedback shapes what we build next</li>
        </ul>
        <DialogFooter showCloseButton>
          <Button
            variant="outline"
            nativeButton={false}
            render={<a href="https://discord.gg/T2EndwXe4W" target="_blank" rel="noopener noreferrer" />}
          >
            <MessageCircleIcon className="mr-1.5 h-4 w-4" />
            Join our Discord
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
