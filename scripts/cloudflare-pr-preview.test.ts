import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  previewUrlFromUpload,
  pullRequestPreviewAlias,
  uploadPullRequestPreview,
  uploadWorkersBuildPreview,
  workersBuildPreviewAlias,
} from "./cloudflare-pr-preview.mjs"
import { REQUIRED_ASSET_IGNORE_PATTERNS } from "./verify-deployment-artifacts.mjs"

const VERSION_ID = "64fca16d-9a57-41da-9f66-990655dfcae2"
const PREVIEW_URL = "https://pr-274-aquilla-web-preview.blue-darkness-7674.workers.dev"

function versionUploadOutput(outputPath: string, alias = "pr-274") {
  writeFileSync(outputPath, `${JSON.stringify({
    type: "version-upload",
    version: 1,
    worker_name: "aquilla-web-preview",
    version_id: VERSION_ID,
    preview_url: "https://64fca16d-aquilla-web-preview.blue-darkness-7674.workers.dev",
    preview_alias_url: `https://${alias}-aquilla-web-preview.blue-darkness-7674.workers.dev`,
    wrangler_environment: "preview",
  })}\n`)
}

describe("Cloudflare pull request preview upload", () => {
  it.each([0, -1, "", "feature/name", "1.5"])("rejects unsafe PR number %j", (value) => {
    expect(() => pullRequestPreviewAlias(value)).toThrow("invalid pull request number")
  })

  it("turns slash-named branches into stable Cloudflare-safe aliases", () => {
    const alias = workersBuildPreviewAlias("tim/AQU-564/preview hardening")
    expect(alias).toMatch(/^ci-tim-aqu-564-preview-hardening-[a-f0-9]{8}$/)
    expect(alias).toBe(workersBuildPreviewAlias("tim/AQU-564/preview hardening"))
    expect(alias).not.toBe(workersBuildPreviewAlias("tim/AQU-564/another branch"))
    expect(() => workersBuildPreviewAlias("  ")).toThrow("Workers Builds branch is required")
  })

  it("uses the exact structured alias URL returned by Wrangler", () => {
    expect(previewUrlFromUpload({
      worker_name: "aquilla-web-preview",
      version_id: VERSION_ID,
      preview_alias_url: PREVIEW_URL,
    }, { alias: "pr-274" })).toBe(PREVIEW_URL)

    expect(() => previewUrlFromUpload({
      worker_name: "aquilla-web-preview",
      version_id: VERSION_ID,
      preview_alias_url: "https://pr-275-aquilla-web-preview.blue-darkness-7674.workers.dev",
    }, { alias: "pr-274" })).toThrow("expected https://pr-274-aquilla-web-preview")
  })

  it("uploads a sanitized alias and writes the verified URL to GitHub output", async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "aquilla-preview-test-"))
    const githubOutputPath = join(outputDirectory, "github-output")
    const run = vi.fn(async (_command, args, options) => {
      expect(args).toEqual([
        "exec",
        "wrangler",
        "versions",
        "upload",
        "--env=preview",
        "--name=aquilla-web-preview",
        "--preview-alias=pr-274",
        "--message",
        "PR 274 @ abc123",
      ])
      versionUploadOutput(options?.env?.WRANGLER_OUTPUT_FILE_PATH as string)
      return { stdout: "", stderr: "" }
    })

    try {
      mkdirSync(join(outputDirectory, "dist"))
      writeFileSync(
        join(outputDirectory, "dist", ".assetsignore"),
        `${REQUIRED_ASSET_IGNORE_PATTERNS.join("\n")}\n`,
      )
      writeFileSync(join(outputDirectory, "dist", ".DS_Store"), "real escaped metadata shape")

      await expect(uploadPullRequestPreview({
        prNumber: 274,
        commitSha: "abc123",
        cwd: outputDirectory,
        githubOutputPath,
        run,
        log: vi.fn(),
      })).resolves.toEqual({
        alias: "pr-274",
        url: PREVIEW_URL,
        versionId: VERSION_ID,
        workerName: "aquilla-web-preview",
      })
      expect(readFileSync(githubOutputPath, "utf8")).toBe(`url=${PREVIEW_URL}\n`)
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true })
    }
  })

  it("bootstraps only the route-free preview Worker when it is missing", async () => {
    let uploadAttempts = 0
    const run = vi.fn(async (_command, args, options) => {
      if (args.includes("upload")) {
        uploadAttempts += 1
        if (uploadAttempts === 1) {
          throw Object.assign(new Error("pnpm exited with status 1"), {
            output: "You cannot upload a new version of a Worker that does not yet exist",
          })
        }
        versionUploadOutput(options?.env?.WRANGLER_OUTPUT_FILE_PATH as string)
      }
      return { stdout: "", stderr: "" }
    })

    await expect(uploadPullRequestPreview({
      prNumber: 274,
      commitSha: "abc123",
      githubOutputPath: null,
      run,
      log: vi.fn(),
      verifyArtifacts: vi.fn(),
    })).resolves.toMatchObject({ url: PREVIEW_URL })

    expect(run.mock.calls.map(([, args]) => args.slice(0, 4))).toEqual([
      ["exec", "wrangler", "versions", "upload"],
      ["exec", "wrangler", "deploy", "--env=preview"],
      ["exec", "wrangler", "versions", "upload"],
    ])
    expect(run.mock.calls[1]?.[1]).toContain("--name=aquilla-web-preview")
  })

  it("uploads Workers Builds output only to the dedicated preview Worker", async () => {
    const run = vi.fn(async (_command, args, options) => {
      const aliasArg = args.find((arg: string) => arg.startsWith("--preview-alias="))
      const alias = aliasArg?.slice("--preview-alias=".length)
      expect(alias).toBe(workersBuildPreviewAlias("feature/example"))
      expect(args).toContain("--env=preview")
      expect(args).toContain("--name=aquilla-web-preview")
      expect(args).toContain("workers-build:feature/example:build-123 @ abcdef1234567890")
      versionUploadOutput(options?.env?.WRANGLER_OUTPUT_FILE_PATH as string, alias)
      return { stdout: "", stderr: "" }
    })

    await expect(uploadWorkersBuildPreview({
      env: {
        WORKERS_CI: "1",
        WORKERS_CI_BRANCH: "feature/example",
        WORKERS_CI_COMMIT_SHA: "abcdef1234567890",
        WORKERS_CI_BUILD_UUID: "build-123",
      },
      githubOutputPath: null,
      run,
      log: vi.fn(),
      verifyArtifacts: vi.fn(),
    })).resolves.toMatchObject({
      alias: workersBuildPreviewAlias("feature/example"),
      workerName: "aquilla-web-preview",
    })
  })

  it("does not turn an unrelated upload failure into a deploy", async () => {
    const failure = Object.assign(new Error("pnpm exited with status 1"), {
      output: "Cloudflare API authentication failed",
    })
    const run = vi.fn(async () => {
      throw failure
    })

    await expect(uploadPullRequestPreview({
      prNumber: 274,
      commitSha: "abc123",
      githubOutputPath: null,
      run,
      log: vi.fn(),
      verifyArtifacts: vi.fn(),
    })).rejects.toBe(failure)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("rejects an unsafe artifact before any Wrangler command", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aquilla-preview-unsafe-"))
    const run = vi.fn()
    try {
      mkdirSync(join(directory, "dist"))
      writeFileSync(join(directory, "dist", ".DS_Store"), "real escaped metadata shape")

      await expect(uploadPullRequestPreview({
        prNumber: 274,
        commitSha: "abc123",
        cwd: directory,
        githubOutputPath: null,
        run,
        log: vi.fn(),
      })).rejects.toThrow(/cannot read required \.assetsignore policy/)

      expect(run).not.toHaveBeenCalled()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
