// LinkSourceSection — AQU-1525 "Link to a source project" card in
// ProjectSettings → Source & sync.
//
// The settings entry point. The flow itself (picker, the AQU-1526 confirm step,
// the cycle refusal, the seed self-heal) lives in `LinkSourceFlow` because the
// Import dialog's "From another project" tile (AQU-1527) reaches the same action
// and must not grow a second, divergent copy of it. What is left here is this
// card: the heading, the "why you would" sentence (handed to the flow as its
// `intro`, so it steps aside once a link is saved), and the
// `section-link-source` anchor the settings nav and its search index scroll to.
//
// This card is the counterpart of SourceLinkSection: exactly one of the two
// shows, keyed off `sourceProjectId` by ProjectSettings. On success the parent
// refreshes the project record, `sourceProjectId` lands, and this card is
// replaced by SourceLinkSection + the Upstream changes panel.

import { Link2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { LinkSourceFlow } from "./LinkSourceFlow"
import { useT } from "@/lib/i18n/I18nProvider"

export interface LinkSourceSectionProps {
  projectId: string
  /** Called after a successful link so the parent can refresh the project record. */
  onLinked: () => void
  /** The caller's resolved role level on this project. */
  roleLevel: number | null
}

export function LinkSourceSection({ projectId, onLinked, roleLevel }: LinkSourceSectionProps) {
  const t = useT()
  return (
    <Card id="section-link-source">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          {t("projectSettings.linkSource.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <LinkSourceFlow
          projectId={projectId}
          onLinked={onLinked}
          roleLevel={roleLevel}
          intro={
            <div className="text-sm text-muted-foreground">
              {t("projectSettings.linkSource.description")}
            </div>
          }
        />
      </CardContent>
    </Card>
  )
}
