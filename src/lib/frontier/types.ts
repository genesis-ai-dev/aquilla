export interface FrontierSession {
  jwt: string;
  gitlabToken: string;
  gitlabUrl: string;      // e.g. "https://gitlab.frontierrnd.com"
  username: string;
  createdAt: string;      // ISO
}

export interface FrontierGroup {
  id: number;
  name: string;
  path: string;
  description?: string;
}

export interface GitlabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  description: string | null;
  http_url_to_repo: string;
  default_branch: string;
  last_activity_at: string;
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
  namespace?: {
    id: number;
    path: string;
    full_path: string;
    kind: "user" | "group";
  };
  owner?: { id: number; username: string };
}
