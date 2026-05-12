// GitLab user provisioning + PAT minting. Used by /register and /token to
// keep the GitLab-backed git remotes working for users who go through this
// worker. Ported from frontier-server/cloudflare/src/services/gitlab.ts,
// strongly typed (no `any`) and trimmed to the surface auth.ts actually
// touches (createOrGetUser, createPersonalAccessToken, getUserInfo,
// getUserProjectsCount, updateUserPassword, deleteUser).

import type { Env } from "../types"

const GITLAB_PAT_SCOPES = [
  "api",
  "read_user",
  "read_repository",
  "write_repository",
]

export interface GitLabUser {
  id: number
  username: string
  email: string
  access_token: string
  gitlab_url: string
  just_created?: boolean
}

export interface GitLabAccountInfo {
  user_id: number
  username: string
  project_count: number
  access_token: string
  gitlab_url: string
}

interface GitLabUserApiResponse {
  id: number
  username: string
  email: string
}

interface GitLabPATResponse {
  token: string
}

export class GitLabService {
  private env: Env
  private baseUrl: string
  private adminToken: string

  constructor(env: Env) {
    this.env = env
    const rawUrl = String(env.GITLAB_URL || "").trim()
    if (!rawUrl) throw new Error("GITLAB_URL is not configured")
    try {
      new URL(rawUrl)
    } catch {
      throw new Error(`GITLAB_URL is invalid: ${rawUrl}`)
    }
    const rawToken = String(env.GITLAB_ADMIN_TOKEN || "").trim()
    if (!rawToken) throw new Error("GITLAB_ADMIN_TOKEN is not configured")
    this.baseUrl = rawUrl.replace(/\/$/, "")
    this.adminToken = rawToken
  }

  private headers(): Record<string, string> {
    return {
      "PRIVATE-TOKEN": this.adminToken,
      Accept: "application/json",
    }
  }

  async createPersonalAccessToken(
    username: string,
    // Password is unused in this PAT-mint flow but kept in the signature for
    // call-site parity with the legacy server (which also ignored it).
    _password: string, // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<{ access_token: string; token_type: string; gitlab_url: string }> {
    // Look up the user by username so we know the numeric ID for the PAT URL.
    const user = await this.getGitLabUserByUsername(username)
    const url = `${this.baseUrl}/api/v4/users/${user.id}/personal_access_tokens`
    const body = {
      name: "Codex Web Access",
      scopes: GITLAB_PAT_SCOPES,
      expires_at: null,
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(
        `Failed to create GitLab PAT: ${response.status} - ${errorText}`,
      )
    }
    const tokenData = (await response.json()) as GitLabPATResponse
    return {
      access_token: tokenData.token,
      token_type: "Bearer",
      gitlab_url: this.baseUrl,
    }
  }

  async createOrGetUser(
    username: string,
    email: string,
    password: string,
  ): Promise<GitLabUser> {
    try {
      const userData = await this.createGitLabUser(username, email, password)
      userData.just_created = true
      const tokenData = await this.createPersonalAccessToken(username, password)
      return { ...userData, ...tokenData }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes("409")) {
        // Idempotent recovery: if the GitLab user already exists with the
        // same email (common after partial failures), proceed.
        try {
          const existing = await this.getGitLabUserByUsername(username)
          if (existing.email?.toLowerCase?.() === email.toLowerCase()) {
            const tokenData = await this.createPersonalAccessToken(
              username,
              password,
            )
            return { ...existing, ...tokenData }
          }
          throw new Error(
            "Email address is already registered with a different username",
          )
        } catch (lookupError) {
          if (
            msg.includes("Email has already been taken") ||
            msg.includes("Email already exists")
          ) {
            throw new Error(
              "Email address is already registered with a different username",
            )
          }
          console.error(
            `Failed to resolve GitLab 409 for ${username}:`,
            lookupError,
          )
          throw error
        }
      }
      throw error
    }
  }

  async getGitLabUserByUsername(username: string): Promise<GitLabUser> {
    const direct = `${this.baseUrl}/api/v4/users/${username}`
    const search = `${this.baseUrl}/api/v4/users?username=${username}`
    let response = await fetch(direct, { headers: this.headers() })
    if (response.ok) {
      const user = (await response.json()) as GitLabUserApiResponse
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        access_token: "",
        gitlab_url: this.baseUrl,
      }
    }
    response = await fetch(search, { headers: this.headers() })
    if (response.ok) {
      const users = (await response.json()) as GitLabUserApiResponse[]
      for (const u of users) {
        if (u.username.toLowerCase() === username.toLowerCase()) {
          return {
            id: u.id,
            username: u.username,
            email: u.email,
            access_token: "",
            gitlab_url: this.baseUrl,
          }
        }
      }
    }
    throw new Error(`GitLab user not found for username: ${username}`)
  }

  private async createGitLabUser(
    username: string,
    email: string,
    password: string,
  ): Promise<GitLabUser> {
    const url = `${this.baseUrl}/api/v4/users`
    const body = {
      username,
      email,
      password,
      name: username,
      skip_confirmation: true,
      force_random_password: false,
      reset_password: false,
      projects_limit: 100,
      can_create_group: false,
      admin: false,
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (response.status === 409) {
      const errorData = (await response.json()) as { message?: string }
      const errorMsg = errorData.message || ""
      if (errorMsg.includes("Email has already been taken")) {
        throw new Error("409: Email already exists in GitLab")
      } else if (errorMsg.includes("Username has already been taken")) {
        throw new Error("409: Username already exists in GitLab")
      } else {
        throw new Error(`409: GitLab user creation conflict: ${errorMsg}`)
      }
    }
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`GitLab API error: ${response.status} - ${errorText}`)
    }
    const user = (await response.json()) as GitLabUserApiResponse
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      access_token: "",
      gitlab_url: this.baseUrl,
    }
  }

  async getUserProjectsCount(userId: number): Promise<number> {
    const url = `${this.baseUrl}/api/v4/users/${userId}/projects`
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: { "PRIVATE-TOKEN": this.adminToken },
      })
      if (response.ok) {
        const total = response.headers.get("X-Total")
        return parseInt(total || "0", 10)
      }
      return 0
    } catch (error) {
      console.error("Failed to get GitLab projects count:", error)
      return 0
    }
  }

  /**
   * Refresh the stored PAT for a known frontier user. Returns a user-info
   * payload suitable for `GET /gitlab/info`. Falls back to the stored token
   * if PAT minting fails.
   */
  async getUserInfo(
    username: string,
    storedGitlabUserId: number | null,
    storedGitlabUsername: string | null,
    storedGitlabToken: string | null,
  ): Promise<GitLabAccountInfo> {
    if (!storedGitlabUserId || !storedGitlabUsername) {
      throw new Error("User has no GitLab account on file")
    }
    try {
      const tokenData = await this.createPersonalAccessToken(
        storedGitlabUsername,
        "",
      )
      await this.env.AUTH_DB.prepare(
        "UPDATE users SET gitlab_token = ? WHERE username = ?",
      )
        .bind(tokenData.access_token, username)
        .run()
      const projectCount = await this.getUserProjectsCount(storedGitlabUserId)
      return {
        user_id: storedGitlabUserId,
        username: storedGitlabUsername,
        project_count: projectCount,
        access_token: tokenData.access_token,
        gitlab_url: tokenData.gitlab_url,
      }
    } catch (error) {
      console.error("Failed to refresh GitLab PAT:", error)
      const projectCount = await this.getUserProjectsCount(storedGitlabUserId)
      return {
        user_id: storedGitlabUserId,
        username: storedGitlabUsername,
        project_count: projectCount,
        access_token: storedGitlabToken || "",
        gitlab_url: this.baseUrl,
      }
    }
  }

  async updateUserPassword(
    userId: number,
    newPassword: string,
  ): Promise<boolean> {
    const url = `${this.baseUrl}/api/v4/users/${userId}`
    const body = { password: newPassword, skip_reconfirmation: true }
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      return response.ok
    } catch (error) {
      console.error("Failed to update GitLab password:", error)
      return false
    }
  }

  async deleteUser(userId: number): Promise<boolean> {
    const url = `${this.baseUrl}/api/v4/users/${userId}`
    try {
      const response = await fetch(url, {
        method: "DELETE",
        headers: { "PRIVATE-TOKEN": this.adminToken },
      })
      return response.ok
    } catch (error) {
      console.error("Failed to delete GitLab user:", error)
      return false
    }
  }
}
