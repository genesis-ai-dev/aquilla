import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MessageCircleIcon } from "lucide-react"

const BETA_ENABLED = import.meta.env.VITE_BETA_FLAG === "1"

export function BetaBadge() {
  if (!BETA_ENABLED) return null

  return (
    <Dialog>
      <DialogTrigger className="inline-flex cursor-pointer items-center rounded-full bg-gradient-to-r from-violet-500 to-pink-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow-sm transition-transform hover:scale-105 active:scale-95">
        Beta
      </DialogTrigger>
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
