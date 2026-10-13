// Bible data in the editor (AQU-1689): one wrapper for what rows read.
// Voices (AQU-1687) and Who's Who each have their own context, so a row
// re-renders only when the half it reads changes.

import type { ReactNode } from "react"
import type { BibleData } from "./useBibleData"
import { BibleVoicesContext } from "./voices-context"
import { WhosWhoContext } from "./whos-who-context"

export function BibleDataProvider({ data, children }: { data: BibleData; children: ReactNode }) {
  return (
    <BibleVoicesContext.Provider value={data.voices}>
      <WhosWhoContext.Provider value={data.whosWho}>{children}</WhosWhoContext.Provider>
    </BibleVoicesContext.Provider>
  )
}
