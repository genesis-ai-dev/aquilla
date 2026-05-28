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
      size="icon"
      onClick={onClick}
      disabled={disabled}
      title="Jump to next unfinished cell (Cmd+.)"
      aria-label="Next unfinished"
    >
      <ArrowRight className="h-4 w-4" />
    </Button>
  )
}
