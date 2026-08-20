import { KnowledgeBaseSurface } from "@/components/knowledge/KnowledgeBaseSurface"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { ROLE } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsKnowledge() {
  const t = useT()
  const { activeOrg, activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()

  return (
    <OrgSettingsDetailPage
      title={t("knowledgeBase.title")}
      description={t("knowledgeBase.orgDescription")}
    >
      {activeOrgId != null ? (
        <KnowledgeBaseSurface
          scope={{ kind: "org", id: activeOrgId }}
          jwt={session?.jwt ?? null}
          canManage={(activeOrg?.role.level ?? 0) >= ROLE.MAINTAINER}
          showTitle={false}
        />
      ) : null}
    </OrgSettingsDetailPage>
  )
}
