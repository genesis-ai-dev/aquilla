import type { LegacyIdmlUpgradeResult } from "./types.js"

export function upgradeLegacyIdmlMetadata(_input: unknown): LegacyIdmlUpgradeResult {
  return {
    ok: false,
    diagnostics: [{
      code: "UNSUPPORTED_SCHEMA_VERSION",
      severity: "error",
      message: "Legacy IDML metadata upgrade is not implemented",
    }],
  }
}
