import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Shared back-navigation icon button used by `ImportDialog` and its per-format panels. */
export function ImportDialogBackButton({
  label,
  onClick,
  disabled,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className="-ms-2"
    >
      <ArrowLeft />
    </Button>
  )
}
