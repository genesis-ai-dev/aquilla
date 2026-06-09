// Ambient aliases so route files can annotate `env.AQUILLA_PG`, `db: AquillaDb`,
// and prepared statements without importing — mirrors how the old `D1Database`
// / `D1PreparedStatement` globals worked. Source of truth: db/shim/postgres.ts.
import type {
  AquillaDb as ShimAquillaDb,
  AquillaStatement as ShimAquillaStatement,
} from "../../db/shim/postgres"

declare global {
  type AquillaDb = ShimAquillaDb
  type AquillaStatement = ShimAquillaStatement
}

export {}
