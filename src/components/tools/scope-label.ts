import { useCallback } from "react"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ToolScope } from "../../../shared/tools/manifest"

/** Human label for a permission scope, from the i18n catalog. */
export function useScopeLabel(): (scope: ToolScope) => string {
  const t = useT()
  return useCallback(
    (scope: ToolScope) => {
      switch (scope) {
        case "read:cells":
          return t("extensions.scope.readCells")
        case "read:terms":
          return t("extensions.scope.readTerms")
        case "write:target":
          return t("extensions.scope.writeTarget")
        case "write:validation":
          return t("extensions.scope.writeValidation")
        case "ai:generate":
          return t("extensions.scope.aiGenerate")
        case "read:comments":
          return t("extensions.scope.readComments")
      }
    },
    [t],
  )
}
