import { describe, expect, it } from "vitest"
import { hasChromeVersionTag } from "./VersionBadge"

describe("hasChromeVersionTag", () => {
  it("suppresses the floating badge on AppShell org routes", () => {
    for (const path of [
      "/",
      "/members",
      "/assigned",
      "/preferences",
      "/preferences/appearance",
      "/settings",
      "/settings/identity",
      "/admin",
      "/teams",
      "/teams/10",
      "/projects/p1",
      "/projects/archived",
    ]) {
      expect(hasChromeVersionTag(path), path).toBe(true)
    }
  })

  it("suppresses the floating badge on project workspace routes", () => {
    for (const path of [
      "/project/p1",
      "/project/p1/file/f1",
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
      "/project/p1/debug",
      "/privacy-policy",
    ]) {
      expect(hasChromeVersionTag(path), path).toBe(false)
    }
  })
})
