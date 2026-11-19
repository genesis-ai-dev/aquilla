// In its own module so the leader worker can name its lock without importing
// store.ts (and React with it).

// Names the OPFS dir; changing it strands every device's data (pinned by eventlog-compat.test.ts).
export const STORE_ID = "aquilla-offline"
