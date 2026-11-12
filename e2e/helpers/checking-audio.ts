import { randomUUID } from "node:crypto"
import { mintSyncToken, type SeededProject } from "./seed-project"

/** Real short PCM recordings: exercise R2 download and browser ended events. */
export async function seedCheckingRecordings(jwt: string, project: SeededProject) {
  const token = await mintSyncToken(jwt, project.projectId, project.fileId)
  const base = `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "audio/wav" }
  const samples = 8000
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 2000), 44 + i * 2)
  const events = []
  for (const cellId of project.cellIds.slice(0, 2)) {
    const audioId = `${randomUUID()}.wav`
    const upload = await fetch(`${base}/audio/${project.projectId}/${project.fileId}/${audioId}`, { method: "PUT", headers, body: wav })
    if (!upload.ok) throw new Error(`Audio upload: ${upload.status} ${await upload.text()}`)
    events.push({ id: randomUUID(), schemaVersion: 1, kind: "cell.audio.attach", projectId: project.projectId,
      fileId: project.fileId, cellId, parentId: null, author: "alice", clientTs: Date.now(),
      payload: { audioId, url: `frontier-audio://${audioId}`, slot: "recording", mimeType: "audio/wav", durationMs: 1000 } })
  }
  const saved = await fetch(`${base}/events`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ events }) })
  const result = await saved.json() as { accepted: unknown[]; rejected: unknown[] }
  if (!saved.ok || result.rejected.length || result.accepted.length !== 2) throw new Error(`Audio attachment failed: ${JSON.stringify(result)}`)
}
