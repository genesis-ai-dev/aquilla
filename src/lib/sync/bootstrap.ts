import * as Y from "yjs"
import type { WebsocketProvider } from "y-websocket"
import { createSyncProvider, destroySyncProvider } from "./signaling-provider"
import { createProject, getProject } from "@/lib/store/project-index"
import { loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"
import { saveShare } from "./share-tokens"
import type { ProjectRecord, ShareInvite } from "@/lib/parsers/types"

interface BootstrapMessage {
  type: "bootstrap"
  projectRecord: ProjectRecord
  fileIds: string[]
}

// Host side: serve bootstrap requests from the bootstrap room.
// Call this once per share token on the owner side so incoming peers can receive the project.
export function startBootstrapHost(
  invite: ShareInvite,
  projectRecord: ProjectRecord
): { stop: () => void } {
  const doc = new Y.Doc()
  const roomName = `codex:share:${invite.token}:bootstrap`
  const { provider } = createSyncProvider(doc, roomName)

  provider.awareness.setLocalState({
    role: "host",
    needsBootstrap: false,
  })

  const bootstrapMap = doc.getMap("bootstrap")

  // When a new peer appears with needsBootstrap, verify their PIN hash and serve them
  function handleAwareness() {
    const states = provider.awareness.getStates()
    states.forEach(async (state, clientId) => {
      if (clientId === provider.awareness.clientID) return
      if (!state || state.role !== "joiner" || !state.needsBootstrap) return
      if (bootstrapMap.has(String(clientId))) return // already served

      // PIN verification
      if (invite.pinHash) {
        const offered = state.pinHash as string | undefined
        if (!offered || offered !== invite.pinHash) {
          // Wrong PIN — don't serve. JoinPage shows error after timeout.
          return
        }
      }

      // Build bootstrap message
      const payload: BootstrapMessage = {
        type: "bootstrap",
        projectRecord,
        fileIds: projectRecord.files.map((f) => f.id),
      }
      doc.transact(() => {
        bootstrapMap.set(String(clientId), payload)
      })
    })
  }

  provider.awareness.on("change", handleAwareness)

  return {
    stop() {
      provider.awareness.off("change", handleAwareness)
      destroySyncProvider({ provider, roomName })
      doc.destroy()
    },
  }
}

// Joiner side: connect to bootstrap room, send PIN hash (if provided), receive project record.
export async function joinViaBootstrap(
  token: string,
  pinHash: string | undefined,
  onStatus: (status: string) => void,
  timeoutMs = 30000
): Promise<BootstrapMessage> {
  const doc = new Y.Doc()
  const roomName = `codex:share:${token}:bootstrap`
  const { provider } = createSyncProvider(doc, roomName)

  const selfId = String(provider.awareness.clientID)
  provider.awareness.setLocalState({
    role: "joiner",
    needsBootstrap: true,
    pinHash,
  })

  const bootstrapMap = doc.getMap("bootstrap")

  onStatus("Looking for collaborators...")

  return new Promise<BootstrapMessage>((resolve, reject) => {
    let done = false
    let presenceTimer: ReturnType<typeof setTimeout>
    let timeoutId: ReturnType<typeof setTimeout>

    function finish(payload: BootstrapMessage) {
      clearTimeout(presenceTimer)
      clearTimeout(timeoutId)
      resolve(payload)
    }

    function checkForPayload() {
      if (done) return
      const payload = bootstrapMap.get(selfId) as BootstrapMessage | undefined
      if (payload) {
        done = true
        onStatus("Project received, syncing content...")
        bootstrapMap.unobserve(checkForPayload)
        destroySyncProvider({ provider, roomName })
        doc.destroy()
        finish(payload)
      }
    }

    bootstrapMap.observe(checkForPayload)
    checkForPayload()

    // Detect presence of at least one host after a few seconds; if none, surface "no peers online"
    presenceTimer = setTimeout(() => {
      if (done) return
      const states = provider.awareness.getStates()
      let hasHost = false
      states.forEach((state, clientId) => {
        if (clientId === provider.awareness.clientID) return
        if (state?.role === "host") hasHost = true
      })
      if (!hasHost) {
        onStatus("No collaborators online. Retrying...")
      }
    }, 5000)

    // Overall timeout
    timeoutId = setTimeout(() => {
      if (done) return
      done = true
      bootstrapMap.unobserve(checkForPayload)
      destroySyncProvider({ provider, roomName })
      doc.destroy()
      reject(new Error("Join timed out. No collaborators responded. Ask the owner to open the project."))
    }, timeoutMs)
  })
}

// After bootstrap: sync each file by creating local file-doc and attaching websocket provider to it.
// Returns a cleanup function that destroys all file providers.
export function syncFilesAfterBootstrap(
  token: string,
  fileIds: string[],
  onProgress: (synced: number, total: number) => void
): { stop: () => void } {
  const handles: Array<{ provider: WebsocketProvider; persistenceHandle: ReturnType<typeof loadFileDoc>; roomName: string }> = []
  let syncedCount = 0

  for (const fileId of fileIds) {
    const persistenceHandle = loadFileDoc(fileId)
    const roomName = `codex:share:${token}:file:${fileId}`
    const { provider } = createSyncProvider(persistenceHandle.doc, roomName)

    handles.push({ provider, persistenceHandle, roomName })

    provider.on("sync", (isSynced: boolean) => {
      if (isSynced) {
        syncedCount += 1
        onProgress(syncedCount, fileIds.length)
      }
    })
  }

  return {
    stop() {
      for (const { provider, persistenceHandle, roomName } of handles) {
        destroySyncProvider({ provider, roomName })
        destroyFileDoc(persistenceHandle)
      }
    },
  }
}

// Complete the join: import the project record locally, run file sync, wait for all files.
export async function completeJoin(
  invite: ShareInvite,
  payload: BootstrapMessage,
  onProgress: (synced: number, total: number) => void
): Promise<string> {
  const { projectRecord, fileIds } = payload

  // If project doesn't exist locally, create it
  const existing = await getProject(projectRecord.id)
  if (!existing) {
    await createProject(projectRecord)
  }

  // Persist the share invite so the joiner's ProjectWorkspace picks it up
  // (activeShareToken comes from listShares → useSync activates only with a token).
  await saveShare({
    token: invite.token,
    projectId: projectRecord.id,
    pinHash: invite.pinHash,
    createdAt: invite.createdAt,
    createdBy: invite.createdBy,
  })

  // Sync files and wait briefly for initial data
  const handle = syncFilesAfterBootstrap(invite.token, fileIds, onProgress)

  // Give file sync a moment to pull initial state from peers
  await new Promise((r) => setTimeout(r, 3000))

  // Leave providers running on the joiner's side so they stay in sync.
  // (In a real app we'd hand these to the workspace to manage lifetime.)
  // For now, stop so there's no duplicate later. Re-sync happens naturally on workspace open via useSync.
  handle.stop()

  return projectRecord.id
}
