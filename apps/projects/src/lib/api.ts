// Thin re-export shim over @aquilla/api-client. Kept local so 3b can
// repopulate @aquilla/api-client without breaking imports inside this app.

export {
  fetchProjectList,
  fetchProject,
  AUTH_API_URL,
} from "@aquilla/api-client"

export type {
  ProjectListItem,
  ProjectDetailResponse,
  ProjectMemberRoleSource,
  ProjectFileSummary,
} from "@aquilla/api-client"
