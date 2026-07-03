import { useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type RevealableInputProps = Omit<React.ComponentProps<typeof Input>, "type"> & {
  /** "password" → Show/Hide password; "key" → Show/Hide key */
  revealKind?: "password" | "key"
}

export function RevealableInput({
  revealKind = "password",
  className,
  disabled,
  ...props
}: RevealableInputProps) {
  const [visible, setVisible] = useState(false)
  const noun = revealKind === "key" ? "key" : "password"

  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        disabled={disabled}
        className={cn("pr-10", className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? `Hide ${noun}` : `Show ${noun}`}
        disabled={disabled}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}
