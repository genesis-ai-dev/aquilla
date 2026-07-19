import { describe, expect, it } from "vitest"
import { hasChromeVersionTag } from "./VersionBadge"

describe("hasChromeVersionTag", () => {
  it("suppresses the floating badge on AppShell org routes", () => {
    for (const path of [
      "/",
      "/orgs/all",
      "/orgs/7",
      "/orgs/7/members",
      "/orgs/7/assigned",
      "/orgs/7/settings",
      "/orgs/7/settings/identity",
      "/orgs/7/teams",
      "/orgs/7/teams/10",
      "/orgs/7/archived",
      "/preferences",
      "/preferences/appearance",
      "/admin",
      "/shared",
      "/projects/p1",
    ]) {
      expect(hasChromeVersionTag(path), path).toBe(true)
    }
  })

  it("suppresses the floating badge on project workspace routes", () => {
    for (const path of [
      "/project/p1/editor",
      "/project/p1/editor/file/f1",
      "/project/p1/rules",
      "/project/p1/comments",
      "/project/p1/agent",
      "/project/p1/voice",
    ]) {
      expect(hasChromeVersionTag(path), path).toBe(true)
    }
  })

  it("keeps the floating badge on standalone centred pages", () => {
    for (const path of [
      "/login",
      "/onboarding",
      "/join/tok",
      "/project/p1/settings",
      "/project/p1/settings/ai",
      "/project/p1/debug",
      "/privacy-policy",
    ]) {
      expect(hasChromeVersionTag(path), path).toBe(false)
    }
  })
})
