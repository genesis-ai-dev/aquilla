import migration001 from "./001_initial.sql?raw"

export interface Migration {
  version: number
  sql: string
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: 1, sql: migration001 },
]
