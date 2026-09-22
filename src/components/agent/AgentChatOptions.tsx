import { useRef, useState } from "react"
import { RotateCcw } from "lucide-react"
import { OverflowMenu } from "@/components/OverflowMenu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useT } from "@/lib/i18n/I18nProvider"

export function AgentChatOptions({
  onReset,
  disabled = false,
}: {
  onReset: () => void
  /** Do not reset review state while an apply or undo is in flight. */
  disabled?: boolean
}) {
  const t = useT()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <OverflowMenu
        ariaLabel={t("agent.chatOptions.label")}
        triggerSize="icon-sm"
        triggerRef={triggerRef}
        items={[{
          id: "reset-chat",
          label: t("agent.chatOptions.resetItem"),
          icon: RotateCcw,
          destructive: true,
          disabled,
          onClick: () => setConfirmOpen(true),
        }]}
      />
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent initialFocus={cancelRef} finalFocus={triggerRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("agent.chatOptions.resetTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("agent.chatOptions.resetDescription", {
                teamChat: t("agent.team.teamChat"),
                chat: t("agentWorkspace.chat"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRef}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                onReset()
                setConfirmOpen(false)
              }}
            >
              {t("agent.chatOptions.resetConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
