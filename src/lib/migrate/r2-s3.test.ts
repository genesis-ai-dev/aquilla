import { describe, it, expect } from "vitest"
import { sigv4AuthHeader, gitlabLfsKey, audioDestKey } from "./r2-s3"

// WHY: the entire fast-copy path authenticates every R2 CopyObject with SigV4.
// If the signer drifts, every request 403s. We lock it to AWS's OFFICIAL
// `get-vanilla` test vector (from the aws-sig-v4-test-suite) — if we reproduce
// AWS's published signature byte-for-byte, the canonical-request + signing-key
// derivation is correct.
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

describe("sigv4AuthHeader", () => {
  it("reproduces AWS's official get-vanilla signature", () => {
    const auth = sigv4AuthHeader({
      method: "GET",
      canonicalUri: "/",
      canonicalQuery: "",
      headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
      payloadHash: EMPTY_SHA,
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "service",
      amzDate: "20150830T123600Z",
    })
    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    )
  })

  it("sorts + lowercases headers regardless of input order (canonicalization)", () => {
    const base = {
      method: "GET" as const,
      canonicalUri: "/",
      canonicalQuery: "",
      payloadHash: EMPTY_SHA,
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "service",
      amzDate: "20150830T123600Z",
    }
    const a = sigv4AuthHeader({ ...base, headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" } })
    const b = sigv4AuthHeader({ ...base, headers: { "X-Amz-Date": "20150830T123600Z", Host: "example.amazonaws.com" } })
    expect(a).toBe(b)
  })
})

describe("key derivation", () => {
  it("gitlabLfsKey strips the first 4 hex (oid[0:2]/oid[2:4]/oid[4:])", () => {
    expect(gitlabLfsKey("6adbf08b815108caa53f9bb8a014dc499f454ee7c15201405d12cf7d6533d8b5")).toBe(
      "6a/db/f08b815108caa53f9bb8a014dc499f454ee7c15201405d12cf7d6533d8b5",
    )
  })

  it("audioDestKey matches the live audio path the app reads", () => {
    expect(audioDestKey("p1", "f1", "a1.webm")).toBe("projects/p1/files/f1/audio/a1.webm")
  })
})
