import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Props {
  onClick: () => void
  disabled: boolean
}

export function NextUnfinishedButton({ onClick, disabled }: Props) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      title="Jump to next unfinished cell (Cmd+.)"
      aria-label="Next unfinished"
      className="gap-1"
    >
      Next
      <ArrowRight className="h-3.5 w-3.5" />
    </Button>
  )
}
