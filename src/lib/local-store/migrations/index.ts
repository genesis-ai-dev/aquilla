import migration001 from "./001_initial.sql?raw"
import migration002 from "./002_cell_subsystems.sql?raw"
import migration003 from "./003_audio_timings.sql?raw"

export interface Migration {
  version: number
  sql: string
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: 1, sql: migration001 },
  { version: 2, sql: migration002 },
  { version: 3, sql: migration003 },
]
