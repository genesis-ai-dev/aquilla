import { useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"

type RevealableInputProps = Omit<React.ComponentProps<typeof InputGroupInput>, "type"> & {
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
    <InputGroup className={className}>
      <InputGroupInput
        type={visible ? "text" : "password"}
        disabled={disabled}
        {...props}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? `Hide ${noun}` : `Show ${noun}`}
          disabled={disabled}
        >
          {visible ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
