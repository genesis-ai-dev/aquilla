// AQU-2664 (board 73): what the toasts say after a run and after a clear. The
// workspace adds the Undo, which takes the whole step back.

import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { ClearResult, EvenOutResult } from "./even-out"
import type { EvenOutScope } from "./even-out-scopes"

/** A loudness with a real minus ("−16"). */
export const lufsWord = (v: number) => (v < 0 ? `−${Math.abs(v)}` : `${v}`)

/** "212 takes evened out to −16 LUFS. 9 couldn’t go all the way up; they’re marked." */
export function ranToastText(r: EvenOutResult, t: TFunction): string {
  const done = t("editor.evenOut.doneToast", { count: r.evened, lufs: lufsWord(r.targetLufs) })
  return r.held.length > 0 ? `${done} ${t("editor.evenOut.heldToast", { count: r.held.length })}` : done
}

/** "Jesus: 93 takes no longer evened. Their own volumes and the track’s are kept." */
export function clearedToastText(r: ClearResult, scope: EvenOutScope, t: TFunction): string {
  if (scope.pick === "file") return t("editor.evenOut.clearedFile", { count: r.cleared })
  if (scope.pick === "track") return t("editor.evenOut.clearedTrack", { track: scope.names[0] ?? "", count: r.cleared })
  return t("editor.evenOut.clearedTracks", { count: r.cleared })
}
