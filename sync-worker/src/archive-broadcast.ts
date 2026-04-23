// Live broadcast of project-archive updates to file DOs. Kept in its own
// module because importing `partyserver` pulls in cloudflare:* URLs that
// Node doesn't resolve — isolating it lets project-archive.ts stay pure
// and unit-testable without a DO runtime.

import type { Server } from "partyserver"
import { getServerByName } from "partyserver"
import type { ArchiveMarker, FileBroadcaster, ProjectArchiveEnv } from "./project-archive"

export const notifyFileDo: FileBroadcaster = async (
  env: ProjectArchiveEnv,
  projectId: string,
  fileId: string,
  marker: ArchiveMarker
): Promise<void> => {
  const docName = `${projectId}--${fileId}`
  const stub = await getServerByName(
    env.FileSync as unknown as DurableObjectNamespace<Server>,
    docName
  )
  const res = await stub.fetch("http://do.internal/__admin/tombstone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(marker),
  })
  if (!res.ok) {
    throw new Error(`DO returned HTTP ${res.status}`)
  }
}
