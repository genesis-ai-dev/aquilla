/**
 * AQU-2664: the loudness meter off the page, so measuring a long take never
 * blocks the editor. The samples arrive transferred; see loudness-client.ts.
 */

import { runLoudnessRequest, type LoudnessRequest } from "./loudness-protocol"

const post = (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage.bind(self)

// It beats as it measures, so the page knows it is alive (loudness-client.ts).
self.onmessage = (event: MessageEvent<LoudnessRequest>) => {
  runLoudnessRequest(event.data, (msg, transfer) => post(msg, transfer ?? []))
}
