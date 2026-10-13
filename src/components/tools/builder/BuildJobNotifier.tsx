import { useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "@/components/ui/toast"
import { useT } from "@/lib/i18n/I18nProvider"
import { isWatched, onBuildFinished } from "@/lib/tools/build-jobs"

/** Tells the user a Smart Extension build finished while they were elsewhere. */
export function BuildJobNotifier() {
  const t = useT()
  const navigate = useNavigate()
  useEffect(
    () =>
      onBuildFinished((projectId, state) => {
        if (isWatched(projectId)) return
        const ok = state.candidate !== null && state.job === null
        const id = toast.add({
          title: ok ? t("extensions.notify.ready", { name: state.candidate?.manifest.name ?? "" }) : t("extensions.notify.failed"),
          type: ok ? "success" : "error",
          timeout: 0,
          actionProps: {
            children: ok ? t("extensions.notify.review") : t("extensions.notify.open"),
            onClick: () => {
              toast.close(id)
              navigate(`/project/${projectId}/extensions`)
            },
          },
        })
      }),
    [navigate, t],
  )
  return null
}
