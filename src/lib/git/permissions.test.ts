import { describe, it, expect } from "vitest";
import { mapGitlabAccessLevel } from "./permissions";

describe("mapGitlabAccessLevel", () => {
  it("guest (10): comments disabled, no edits, no resolve", () => {
    const p = mapGitlabAccessLevel(10);
    expect(p).toEqual({
      source: "gitlab", canEditContent: false, canEditComments: false,
      canResolveComments: false, canPush: false, accessLevel: 10,
    });
  });

  it("reporter (20): comments yes, no edits, no push", () => {
    const p = mapGitlabAccessLevel(20);
    expect(p.canEditContent).toBe(false);
    expect(p.canEditComments).toBe(true);
    expect(p.canPush).toBe(false);
  });

  it("developer (30)+: edits AND push enabled", () => {
    const p = mapGitlabAccessLevel(30);
    expect(p.canEditContent).toBe(true);
    expect(p.canEditComments).toBe(true);
    expect(p.canResolveComments).toBe(true);
    expect(p.canPush).toBe(true);
  });

  it("undefined defaults to guest", () => {
    const p = mapGitlabAccessLevel(undefined);
    expect(p.canEditComments).toBe(false);
  });
});
