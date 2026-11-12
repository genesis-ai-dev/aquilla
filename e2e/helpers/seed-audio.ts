/**
 * Seed a recorded take on a cell: a short generated WAV uploaded to the
 * sync-worker's audio store, then the `cell.audio.attach` event — the same two
 * steps the app's recorder takes (uploadCellAudio + emitCellAudioAttach).
 */

import { randomUUID } from "node:crypto"
import { mintSyncToken } from "./seed-project"

const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

/** A mono 16-bit PCM WAV: a tone with a swell, so its waveform has a shape. */
export function toneWav(seconds = 1.5, rate = 16000): Uint8Array<ArrayBuffer> {
  const n = Math.floor(seconds * rate)
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ")
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const env = Math.sin((Math.PI * i) / n)
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * env * 12000), true)
  }
  return new Uint8Array(buf)
}

export async function seedCellAudio(jwt: string, opts: { projectId: string; fileId: string; cellId: string; author: string; seconds?: number; /** The target lane the take performs (takes are per lane). */ targetLang?: string }): Promise<string> {
  const token = await mintSyncToken(jwt, opts.projectId, opts.fileId)
  const audioId = randomUUID()
  const seconds = opts.seconds ?? 1.5
  const put = await fetch(`${SYNC_BASE}/audio/${opts.projectId}/${opts.fileId}/${audioId}.wav`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "audio/wav" },
    body: new Blob([toneWav(seconds)], { type: "audio/wav" }),
  })
  if (!put.ok) throw new Error(`audio upload failed: HTTP ${put.status} — ${await put.text()}`)
  const res = await fetch(`${SYNC_BASE}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events: [{
      id: randomUUID(), schemaVersion: 1, projectId: opts.projectId, fileId: opts.fileId, cellId: opts.cellId, parentId: null,
      kind: "cell.audio.attach", author: opts.author, clientTs: Date.now(),
      payload: { audioId, url: `frontier-audio://${audioId}.wav`, slot: "recording", mimeType: "audio/wav", durationMs: Math.round(seconds * 1000), ...(opts.targetLang ? { targetLang: opts.targetLang } : {}) },
    }] }),
  })
  if (!res.ok) throw new Error(`attach failed: HTTP ${res.status} — ${await res.text()}`)
  return audioId
}
