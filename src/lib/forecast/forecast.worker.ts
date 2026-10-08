/**
 * BIA forecast worker: owns the corpus index off the main thread so building
 * a Bible-sized index and answering per-keystroke queries never block typing.
 */

import { BiaEngine } from "./bia-engine"
import { answerForecastQuery, applyForecastCommand, type ForecastRequest, type ForecastResponse } from "./forecast-protocol"

const engine = new BiaEngine()

self.onmessage = (event: MessageEvent<ForecastRequest>) => {
  const message = event.data
  if (message.type !== "query") {
    applyForecastCommand(engine, message)
    return
  }
  let response: ForecastResponse
  try {
    response = { id: message.id, ...answerForecastQuery(engine, message.query) }
  } catch (cause) {
    response = { id: message.id, error: cause instanceof Error ? cause.message : String(cause) }
  }
  self.postMessage(response)
}
