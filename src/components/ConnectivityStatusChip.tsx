import { Wifi, WifiOff } from "lucide-react"
import { useConnectivity } from "@/lib/offline/connectivity"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"

/**
 * Online/offline status chip (Phase 5 task 5). Renders nothing outside the
 * Tauri desktop app, or before the first `get_connectivity` call resolves —
 * the browser SPA is always "online" from its own perspective (no offline
 * mode exists there), so this chip would be pure noise on the web.
 */
export function ConnectivityStatusChip() {
  const t = useT()
  const online = useConnectivity()
  if (!isTauriRuntime() || online === null) return null

  const label = online ? t("workspace.offline.connectivityOnline") : t("workspace.offline.connectivityOffline")
  const tooltip = online
    ? t("workspace.offline.connectivityTooltipOnline")
    : t("workspace.offline.connectivityTooltipOffline")

  return (
    <AppTooltip content={tooltip} side="top">
      <span
        data-testid="connectivity-status-chip"
        data-online={online}
        className={
          online
            ? "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground"
            : "inline-flex items-center gap-1 rounded-md bg-amber-100 px-1.5 py-1 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
        }
      >
        {online ? <Wifi className="size-3" aria-hidden /> : <WifiOff className="size-3" aria-hidden />}
        {label}
      </span>
    </AppTooltip>
  )
}
