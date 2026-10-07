import { useI18n } from "@/lib/i18n/I18nProvider"

/** Shared human formatting for the connection popover and details dialog. */
export function useConnectionFormat() {
  const { t, locale } = useI18n()
  const number = (value: number, digits = 0) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)
  const formatBytes = (bytes: number) => {
    const unit = bytes >= 1_000_000 ? "MB" : bytes >= 1_000 ? "kB" : "B"
    const value = bytes >= 1_000_000 ? bytes / 1_000_000 : bytes >= 1_000 ? bytes / 1_000 : bytes
    return `${number(value, 1)} ${unit}`
  }
  const formatRate = (bytes: number, connected: boolean) => !connected ? "—"
    : bytes === 0 ? t("editor.sync.noActivity") : `${formatBytes(bytes)}/s`
  // Nearest 10 ms: finer digits change every second and carry no meaning.
  const formatLatency = (ms: number | null) => ms == null ? "—" : `${number(Math.round(ms / 10) * 10)} ms`
  return { formatBytes, formatRate, formatLatency }
}
