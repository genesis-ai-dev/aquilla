// Read-only readiness check. Does not open daemon.db, acquire/delete a lease,
// scan GitLab or change checkpoints. Never prints environment/credentials.
import { loadConfig } from './config'
import { SyncClient } from './http'

async function main() {
  const config = loadConfig()
  if (!config.directIngest) throw new Error('Direct transport is not configured; all MIGRATE_INGEST_* settings are required')
  const client = new SyncClient(config.syncBase, config.syncSecret, config.runner, {}, {
    ...config.directIngest,
    identity: () => undefined, // This command must never submit writes.
  })
  await client.checkDirectReadiness()
  console.log('PASS direct migration readiness: pinned destination, contract, writes enabled and 250-event limit')
}
main().catch(() => {
  console.error('FAIL direct migration readiness; inspect configuration and worker logs (no migration started)')
  process.exitCode = 1
})
