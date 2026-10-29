// Dedicated leader worker for the offline LiveStore adapter. Bundled via the
// `?worker` Vite suffix and handed to `makePersistedAdapter({ worker: ... })`
// in store.ts — LiveStore boots its leader thread (SQLite + sync processor)
// inside this worker rather than the main thread.
import { makeWorker } from "@livestore/adapter-web/worker"
import { installLeaderLogForwarder } from "./leader-log-bridge"
import { installRebuildProgressForwarder } from "./boot-progress"
import { makeLocalSyncBackend } from "./local-sync-backend"
import { schema } from "./schema"

if (import.meta.env.DEV) installLeaderLogForwarder()
installRebuildProgressForwarder()

makeWorker({ schema, sync: { backend: makeLocalSyncBackend } })
