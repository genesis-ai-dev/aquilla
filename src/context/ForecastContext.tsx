/**
 * ForecastContext — the project's BIA forecast engine (ghost-text next-word
 * suggestions and the "words that fit here" thesaurus) for the editor subtree.
 *
 * Provided once at the EditorTable render site in ProjectWorkspace, like
 * EditorActionsContext, so the editor rows read it without another prop on
 * the ~40-prop row bag. Absent provider = feature off.
 */

import { createContext, useContext, type ReactNode } from "react"
import type { ForecastClient } from "@/lib/forecast/forecast-client"

export interface ForecastContextValue {
  client: ForecastClient
  /** The device setting for ghost text; the thesaurus ignores it. */
  ghostTextEnabled: boolean
}

const ForecastContext = createContext<ForecastContextValue | null>(null)

export function ForecastProvider({ value, children }: { value: ForecastContextValue | null; children: ReactNode }) {
  return <ForecastContext.Provider value={value}>{children}</ForecastContext.Provider>
}

export function useForecast(): ForecastContextValue | null {
  return useContext(ForecastContext)
}
