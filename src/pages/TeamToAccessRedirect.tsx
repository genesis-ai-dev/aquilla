import { Navigate, useParams } from "react-router-dom"

/**
 * The old team page, `/orgs/:orgId/teams/:groupId`. Teams are folders on
 * People & access now, so the link opens that page with the folder marked.
 */
export function TeamToAccessRedirect() {
  const { groupId } = useParams()
  const query = groupId ? `?place=team:${encodeURIComponent(groupId)}` : ""
  return <Navigate to={`../../access${query}`} replace relative="path" />
}
