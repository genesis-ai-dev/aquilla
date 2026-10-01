import { useState, type ReactNode } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useMemberInspectorAccess } from "@/hooks/useMemberInspectorAccess"
import type { ScopePath } from "@/lib/access/types"
import type { AccessFromScope } from "@/lib/sync/access-read"
import { useT } from "@/lib/i18n/I18nProvider"

import { MemberInspector } from "./MemberInspector"

/**
 * AQU-1352 §3.8: wraps a roster name/avatar so clicking it opens the member
 * inspector. Fetches only while open. "Manage access" is a link-style action
 * handed in by the roster (rule 3: nothing is edited in here).
 */
export function MemberInspectorTrigger({
  userId,
  username,
  from,
  herePath,
  onManageAccess,
  children,
}: {
  userId: number | string
  /** Roster username: the button label and how "Your access" is detected. */
  username: string
  from: AccessFromScope
  herePath: ScopePath
  onManageAccess?: () => void
  children: ReactNode
}) {
  const t = useT()
  const { session } = useFrontierSession()
  const isSelf = session?.username === username
  const [open, setOpen] = useState(false)
  const state = useMemberInspectorAccess(open ? userId : null, from)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t("org.access.inspector.open", { name: username })}
            className="inline-flex min-w-0 cursor-pointer items-center rounded text-start hover:underline focus-visible:outline-2"
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)]">
        {state.status === "ready" ? (
          <MemberInspector
            member={state.data}
            herePath={herePath}
            isSelf={isSelf}
            onManageAccess={
              onManageAccess
                ? () => {
                    setOpen(false)
                    onManageAccess()
                  }
                : undefined
            }
          />
        ) : state.status === "error" ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {t(state.forbidden ? "org.access.inspector.forbidden" : "org.access.inspector.loadError")}
          </p>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-3.5" />
            {t("org.access.inspector.loading")}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
