import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

const BETA_ENABLED = import.meta.env.VITE_BETA_FLAG === "1"

export function BetaBadge() {
  if (!BETA_ENABLED) return null

  return (
    <Dialog>
      <DialogTrigger className="mt-2 inline-flex cursor-pointer items-center rounded-full bg-gradient-to-r from-violet-500 to-pink-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow-sm transition-transform hover:scale-105 active:scale-95">
        beta
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>heads up — we're in beta</DialogTitle>
          <DialogDescription>
            things might move around, break, or change without warning. that's
            the deal for now.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li>the UI is actively evolving</li>
          <li>features may appear or disappear</li>
          <li>your feedback shapes what we build next</li>
        </ul>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}
