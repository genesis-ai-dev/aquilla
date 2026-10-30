/**
 * A step's name, as the History panel, the Undo button and the toasts say it.
 * (AQU-2262)
 *
 * A step is saved with its name's parts (`labelParams`). A settings step also
 * carries the setting's own message key (`settingKey`) beside the name it was
 * given when recorded (`setting`), so it reads in whatever language is shown
 * now — the history follows the person to devices set to other languages.
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
  const params = s.labelParams
  const settingKey = params?.settingKey
  if (typeof settingKey === "string") {
    const setting = known(settingKey) ? t(settingKey as never) : String(params?.setting ?? "")
    return t(s.labelKey as never, { ...params, setting } as never)
  }
  return t(s.labelKey as never, params as never)
}
