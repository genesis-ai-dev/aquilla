import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"

interface Props {
  onClick: () => void
  disabled: boolean
}

export function NextUnfinishedButton({ onClick, disabled }: Props) {
  return (
    <AppTooltip content="Jump to next unfinished cell (Cmd+.)">
      <Button
        variant="ghost"
        size="icon"
        onClick={onClick}
        disabled={disabled}
        aria-label="Next unfinished"
      >
        <ArrowRight className="h-4 w-4" />
      </Button>
    </AppTooltip>
  )
}
