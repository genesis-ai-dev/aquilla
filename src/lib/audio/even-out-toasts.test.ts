// AQU-2664 (board 73): the words of the toasts after a run and after a clear.
import { describe, expect, it } from "vitest"
import { translate } from "@/lib/i18n/translate"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { clearedToastText, ranToastText } from "./even-out-toasts"
import type { EvenOutResult } from "./even-out"
import type { EvenOutScope } from "./even-out-scopes"

const t: TFunction = (key, vars) => translate(undefined, key, vars)
const run = (over: Partial<EvenOutResult>): EvenOutResult => ({
  targetLufs: -16, evened: 0, skipped: 0, unmeasured: 0, silent: 0, gone: 0, held: [], failed: 0, ...over,
})
const held = (n: number) => Array.from({ length: n }, (_, i) => ({ cellId: `c${i}`, audioId: `a${i}`, reason: "peak" as const, shortDb: 2 }))
const scope = (pick: EvenOutScope["pick"], names: string[] = []): EvenOutScope => ({ pick, names, trackCount: names.length, takes: [], evened: [] })

describe("the toasts", () => {
  it("after a run (73A)", () => {
    expect(ranToastText(run({ evened: 212, held: held(9) }), t)).toBe("212 takes evened out to −16 LUFS. 9 couldn’t go all the way up; they’re marked.")
    expect(ranToastText(run({ evened: 3 }), t)).toBe("3 takes evened out to −16 LUFS.")
    expect(ranToastText(run({ evened: 1, held: held(1) }), t)).toBe("1 take evened out to −16 LUFS. 1 couldn’t go all the way up; it’s marked.")
  })

  it("after clearing a track, the file, or the selected tracks (73E–H)", () => {
    expect(clearedToastText({ cleared: 93, gone: 0, failed: 0 }, scope("track", ["Jesus"]), t)).toBe("Jesus: 93 takes no longer evened. Their own volumes and the track’s are kept.")
    expect(clearedToastText({ cleared: 212, gone: 0, failed: 0 }, scope("file"), t)).toBe("212 takes no longer evened. Every volume you set is kept.")
    expect(clearedToastText({ cleared: 179, gone: 0, failed: 0 }, scope("sel", ["A", "B", "C"]), t)).toBe("179 takes no longer evened. Their own volumes and the tracks’ are kept.")
  })

  it("after clearing one take in the Station (73G)", () => {
    expect(t("editor.evenOut.clearedTake", { take: "Take 2", line: "694", volume: "−2 dB" })).toBe("Take 2 on 694 is no longer evened. Your volume (−2 dB) is kept.")
  })
})
