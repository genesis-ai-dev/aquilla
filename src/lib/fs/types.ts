import type { OpfsFs } from "@/lib/git/opfs-fs";

// FsProvider is the contract that isomorphic-git, git-sync, and git-importer
// all consume. On web it's backed by OPFS; on Tauri it's backed by Rust IPC.
// Keeping the shape identical to OpfsFs means callers don't need to change.
export type FsProvider = OpfsFs;

export interface FsProviderOptions {
  // When true, wipe any existing repo dir before returning the provider.
  // Used by git-importer before re-cloning.
  reset?: boolean;
}
