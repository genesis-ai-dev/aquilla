/**
 * A step's name, as the History panel, the Undo and Redo tooltips and the
 * toasts say it. A step is saved with its name's message key and parts
 * (`labelKey`, `labelParams`).
 */
import { en } from "@/lib/i18n/messages/en"
import type { StepSummary } from "./history"

type Translate = (key: never, params?: never) => string

// The history follows the person to their other devices, and those may run
// another version of the app: a step a newer one recorded can name a message
// this one does not have, and naming it must not take the page down.
const known = (key: unknown): key is string => typeof key === "string" && Object.prototype.hasOwnProperty.call(en, key)

export function stepLabel(t: Translate, s: Pick<StepSummary, "labelKey" | "labelParams">): string {
  if (!known(s.labelKey)) return t("editor.history.stepUnknown" as never)
  return t(s.labelKey as never, s.labelParams as never)
}
