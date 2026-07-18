#!/usr/bin/env tsx
// Backward-compatible alias for the target-aware refresh command.

process.argv[2] ||= "dev"
await import("./refresh-neon-branch.ts")
