/**
 * AQU-2664: the loudness meter off the page, so measuring a long take never
 * blocks the editor. The samples arrive transferred; see loudness-client.ts.
 */

import { answerLoudnessRequest, type LoudnessRequest } from "./loudness-protocol"

self.onmessage = (event: MessageEvent<LoudnessRequest>) => {
  const { response, transfer } = answerLoudnessRequest(event.data)
  ;(self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(response, transfer)
}
