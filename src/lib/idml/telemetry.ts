import type { IdmlDiagnostic, IdmlExportReport } from "@aquilla/idml-roundtrip"

interface IdmlTelemetryCell {
  metadata?: Record<string, unknown> | null
}

export interface IdmlTelemetryInput {
  cells: readonly IdmlTelemetryCell[]
  report?: IdmlExportReport
  diagnostics?: readonly IdmlDiagnostic[]
  durationMs: number
}

export interface IdmlTelemetryProperties {
  profile_version: 2
  unit_count: number
  editable_slot_count: number
  protected_token_count: number
  failure_codes: string[]
  mapping_failures: number
  export_size_delta: number
  validation_duration_ms: number
}

/**
 * The only IDML telemetry boundary. It accepts no source/target HTML, text,
 * member paths, file names, or locator identifiers.
 */
export function idmlTelemetryProperties(
  input: IdmlTelemetryInput,
): IdmlTelemetryProperties {
  let editableSlots = 0
  let protectedTokens = 0
  let unitCount = 0
  for (const cell of input.cells) {
    const metadata = cell.metadata?.idml
    if (!isRecord(metadata) || metadata.version !== 2) continue
    unitCount += 1
    editableSlots += Array.isArray(metadata.editableSlotIndexes)
      ? metadata.editableSlotIndexes.length
      : 0
    protectedTokens += safeCount(metadata.protectedTokenCount)
  }
  const diagnostics = [
    ...(input.diagnostics ?? []),
    ...(input.report?.warnings ?? []),
  ]
  const failureCodes = [...new Set(diagnostics.map((entry) => (
    /^[A-Z][A-Z0-9_]{1,63}$/.test(entry.code) ? entry.code : "UNKNOWN"
  )))]
  return {
    profile_version: 2,
    unit_count: unitCount,
    editable_slot_count: editableSlots,
    protected_token_count: protectedTokens,
    failure_codes: failureCodes,
    mapping_failures: safeCount(input.report?.missing) + safeCount(input.report?.rejected),
    export_size_delta: Math.trunc(input.report?.sizeDelta ?? 0),
    validation_duration_ms: Math.max(0, Math.round(input.durationMs)),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0
}
