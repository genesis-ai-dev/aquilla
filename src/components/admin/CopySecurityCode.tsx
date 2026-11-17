import { useState } from "react"
import { Button } from "@/components/ui/button"

/** Copy only on an explicit gesture; never include the secret in feedback. */
export function CopySecurityCode({
  value,
  label,
}: {
  value: string
  label: string
}) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null)
  return (
    <div
      className="flex flex-wrap items-center gap-2 ph-no-capture"
      data-ph-mask
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setResult(null)
          // Invoke synchronously within the gesture for Safari clipboard permissions.
          try {
            void navigator.clipboard.writeText(value).then(
              () => setResult("copied"),
              () => setResult("failed"),
            )
          } catch {
            setResult("failed")
          }
        }}
      >
        {label}
      </Button>
      <span role="status" className="text-xs text-muted-foreground">
        {result === "copied"
          ? "Copied"
          : result === "failed"
            ? "Could not copy. Please try the copy button again."
            : null}
      </span>
    </div>
  )
}
