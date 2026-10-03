import path from "node:path"
import { fileURLToPath } from "node:url"
import { refuseBorrowedNodeModules } from "./lib/worktree-install-guard"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
refuseBorrowedNodeModules(repoRoot)
