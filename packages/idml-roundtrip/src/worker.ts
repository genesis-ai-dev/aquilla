import { exportIdml, parseIdml, validateExport } from "./engine.js"
import { inspectIdml } from "./archive.js"

export const idmlWorkerApi = {
  inspectIdml,
  parseIdml,
  exportIdml,
  validateExport,
}

export type IdmlWorkerApi = typeof idmlWorkerApi
