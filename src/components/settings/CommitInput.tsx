/**
 * Inputs for settings that save as you change them. (AQU-2262)
 *
 * They save after a short pause in typing or when you leave them, never on
 * every keystroke and never with a half-typed value (see useCommitOnPause).
 * `onCommit` gets the value and the change's `CommitInfo`: `final` once the
 * person has left the field, with `from` the value they started from.
 */
import type { ComponentProps } from "react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { numberField, useCommitOnPause, type CommitInfo } from "@/lib/settings/useCommitOnPause"

type InputRest = Omit<ComponentProps<typeof Input>, "value" | "defaultValue" | "onChange" | "onBlur" | "onKeyDown" | "type">

const textParse = (required: boolean) => (text: string): string | null => {
  const trimmed = text.trim()
  return required && trimmed === "" ? null : trimmed
}

export function CommitTextInput({
  value,
  onCommit,
  required = false,
  ...rest
}: InputRest & {
  value: string
  onCommit: (next: string, info: CommitInfo<string>) => void
  /** An empty value is not a whole one: it is never saved. */
  required?: boolean
}) {
  const field = useCommitOnPause({ value, toText: (v) => v, parse: textParse(required), commit: onCommit })
  return <Input {...rest} {...field} />
}

export function CommitNumberInput({
  value,
  onCommit,
  min,
  max,
  integer = true,
  ...rest
}: Omit<InputRest, "min" | "max"> & {
  value: number
  onCommit: (next: number, info: CommitInfo<number>) => void
  min: number
  max: number
  /** Round to a whole number (default). */
  integer?: boolean
}) {
  const field = useCommitOnPause({ value, ...numberField({ min, max, integer }), commit: onCommit })
  return <Input {...rest} type="number" min={min} max={max} {...field} />
}

export function CommitTextarea({
  value,
  onCommit,
  ...rest
}: Omit<ComponentProps<typeof Textarea>, "value" | "defaultValue" | "onChange" | "onBlur" | "onKeyDown"> & {
  value: string
  onCommit: (next: string, info: CommitInfo<string>) => void
}) {
  const field = useCommitOnPause({ value, toText: (v) => v, parse: textParse(false), commit: onCommit })
  // Enter makes a new line in a text area; leaving it (or a pause) saves.
  return <Textarea {...rest} value={field.value} onChange={field.onChange} onBlur={field.onBlur} onKeyDown={(e) => { if (e.key === "Escape") field.onKeyDown(e) }} />
}
