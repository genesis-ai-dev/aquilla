/**
 * A step's name, as the History panel, the Undo button and the toasts say it.
 * (AQU-2262)
 *
 * A step is saved with its name's parts (`labelParams`). A settings step also
 * carries the setting's own message key (`settingKey`) beside the name it was
 * given when recorded (`setting`), so it reads in whatever language is shown
 * now — the history follows the person to devices set to other languages.
 */
import type { StepSummary } from "./history"

type Translate = (key: never, params?: never) => string

export function stepLabel(t: Translate, s: Pick<StepSummary, "labelKey" | "labelParams">): string {
  const params = s.labelParams
  const settingKey = params?.settingKey
  if (typeof settingKey === "string") {
    return t(s.labelKey as never, { ...params, setting: t(settingKey as never) } as never)
  }
  return t(s.labelKey as never, params as never)
}
