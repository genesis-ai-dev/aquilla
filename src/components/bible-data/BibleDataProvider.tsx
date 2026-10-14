// Bible data in the editor (AQU-1689): one wrapper for what rows read.
// Voices (AQU-1687) and Who's Who each have their own context, so a row
// re-renders only when the half it reads changes. AQU-1693 adds what the
// popovers need for "Add to terminology".

import type { ReactNode } from "react"
import type { BibleData } from "./useBibleData"
import { EntityTermActionsContext, type EntityTermActions } from "./entity-term-context"
import { BibleVoicesContext } from "./voices-context"
import { WhosWhoContext } from "./whos-who-context"

export function BibleDataProvider({
  data,
  termActions,
  children,
}: {
  data: BibleData
  /** AQU-1693: "Add to terminology" in the popovers; null when the person can do neither. */
  termActions: EntityTermActions | null
  children: ReactNode
}) {
  return (
    <BibleVoicesContext.Provider value={data.voices}>
      <WhosWhoContext.Provider value={data.whosWho}>
        <EntityTermActionsContext.Provider value={termActions}>{children}</EntityTermActionsContext.Provider>
      </WhosWhoContext.Provider>
    </BibleVoicesContext.Provider>
  )
}
