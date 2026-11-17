import type { CSSProperties } from "react"
import {
  TRAFFIC_LIGHTS_HEIGHT,
  TRAFFIC_LIGHTS_WIDTH,
  titlebarInsets,
  useMacTitlebarOverlay,
  useTitlebarDrag,
  type TitlebarDragProps,
  type TitlebarInsetInput,
} from "@/hooks/useMacTitlebarOverlay"

type RegionProps = TitlebarDragProps & { style?: CSSProperties }

export interface AppShellTitlebar {
  /** The sidebar chrome row is pushed past the traffic lights: it drops the
   *  brand mark and beta chip to make room. */
  insetSidebarRow: boolean
  /** Spread on the sidebar's chrome row (`app-shell-sidebar-chrome`). */
  sidebarChromeProps: RegionProps
  /** Spread on the header band (`app-shell-header`). */
  headerProps: RegionProps
}

/**
 * AppShell's part in the macOS overlay title bar (useMacTitlebarOverlay):
 * its top strip doubles as the window's title bar — except in native
 * fullscreen, where there is no window to move or zoom — and whatever sits
 * under the traffic lights is inset clear of them (titlebarInsets). Inert
 * (empty props) outside the overlay shell.
 */
export function useAppShellTitlebar(layout: Omit<TitlebarInsetInput, "inset">): AppShellTitlebar {
  const { inset } = useMacTitlebarOverlay()
  const drag = useTitlebarDrag(inset)
  const { insetSidebarRow, insetRail, headerInset } = titlebarInsets({ ...layout, inset })
  return {
    insetSidebarRow,
    sidebarChromeProps: {
      // In the sheet the row isn't at the window's top edge: no drag there.
      ...(layout.mobileNav ? {} : drag),
      style: insetSidebarRow
        ? { paddingLeft: TRAFFIC_LIGHTS_WIDTH }
        : insetRail
          ? { paddingTop: TRAFFIC_LIGHTS_HEIGHT }
          : undefined,
    },
    headerProps: {
      ...drag,
      style: headerInset > 0 ? { paddingLeft: headerInset } : undefined,
    },
  }
}
