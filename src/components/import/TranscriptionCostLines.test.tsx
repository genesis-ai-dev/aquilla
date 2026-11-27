// AQU-2426: the cost step's Audio line agrees with the requests beside it.
import { describe, expect, it } from "vitest"
import { t } from "@/lib/i18n/standalone"
import { audioLength } from "./TranscriptionCostLines"

const tt = t as unknown as Parameters<typeof audioLength>[0]

describe("audioLength", () => {
  it("under ten minutes keeps the seconds, so 72 s is not '1 minute' beside 2 requests", () => {
    expect(audioLength(tt, 72_000)).toBe("1 minute 12 seconds")
    expect(audioLength(tt, 3 * 60_000)).toBe("3 minutes")
  })
  it("under a minute is seconds; from ten minutes, whole minutes and hours", () => {
    expect(audioLength(tt, 40_000)).toBe("40 seconds")
    expect(audioLength(tt, 52 * 60_000 + 14_000)).toBe("52 minutes")
    expect(audioLength(tt, 100 * 60_000)).toBe("1 hour 40 minutes")
  })
})
