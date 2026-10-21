import { describe, expect, it } from "vitest";
import { isGithubRef, isIssueUrl, issueTone, parseHiddenRepos } from "./pr";
import type { IssueSnapshot } from "./api";

describe("isGithubRef", () => {
  it("accepts PR and issue URLs and the short form", () => {
    expect(isGithubRef("https://github.com/acme/web/pull/12")).toBe(true);
    expect(isGithubRef("https://github.com/acme/web/issues/12#issuecomment-1")).toBe(true);
    expect(isGithubRef("acme/web#12")).toBe(true);
  });

  it("rejects other links", () => {
    expect(isGithubRef("https://github.com/acme/web")).toBe(false);
    expect(isGithubRef("https://example.com/acme/web/pull/1")).toBe(false);
    expect(isGithubRef("fix #12")).toBe(false);
  });

  it("tells issue URLs apart", () => {
    expect(isIssueUrl("https://github.com/acme/web/issues/3")).toBe(true);
    expect(isIssueUrl("https://github.com/acme/web/pull/3")).toBe(false);
  });
});

describe("parseHiddenRepos", () => {
  it("reads a lower-cased set and tolerates bad values", () => {
    expect([...parseHiddenRepos({ hidden_repos: '["Acme/Legacy","acme/old"]' })]).toEqual(["acme/legacy", "acme/old"]);
    expect(parseHiddenRepos({}).size).toBe(0);
    expect(parseHiddenRepos({ hidden_repos: "not json" }).size).toBe(0);
  });
});

describe("issueTone", () => {
  const base = { state: "CLOSED", state_reason: "COMPLETED" } as IssueSnapshot;
  it("distinguishes done from not planned", () => {
    expect(issueTone(base)).toBe("done");
    expect(issueTone({ ...base, state_reason: "NOT_PLANNED" })).toBe("not_planned");
    expect(issueTone({ ...base, state: "OPEN", state_reason: null })).toBe("open");
    expect(issueTone(null)).toBe("unknown");
  });
});
