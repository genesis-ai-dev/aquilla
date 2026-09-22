// Dedicated leader worker for the offline LiveStore adapter. Bundled via the
// `?worker` Vite suffix and handed to `makePersistedAdapter({ worker: ... })`
// in store.ts — LiveStore boots its leader thread (SQLite + sync processor)
// inside this worker rather than the main thread.
import { makeWorker } from "@livestore/adapter-web/worker"
import { schema } from "./schema"

makeWorker({ schema })
