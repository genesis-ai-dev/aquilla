import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { saveSession, loadSession, clearSession } from "./session-store";
import type { FrontierSession } from "./types";

const sample: FrontierSession = {
  jwt: "jwt-x",
  gitlabToken: "glpat-x",
  gitlabUrl: "https://gitlab.example",
  username: "alice",
  createdAt: new Date().toISOString(),
};

describe("session-store", () => {
  beforeEach(async () => { await clearSession(); });

  it("returns null when nothing saved", async () => {
    expect(await loadSession()).toBeNull();
  });

  it("round-trips a session", async () => {
    await saveSession(sample);
    expect(await loadSession()).toEqual(sample);
  });

  it("clears", async () => {
    await saveSession(sample);
    await clearSession();
    expect(await loadSession()).toBeNull();
  });
});
