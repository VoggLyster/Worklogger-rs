import { describe, expect, it } from "vitest";
import { parseCapture } from "./parseCapture";

describe("parseCapture", () => {
  it("returns plain titles untouched", () => {
    expect(parseCapture("  Fix the login bug ")).toEqual({ title: "Fix the login bug" });
  });

  it("extracts priority, project, agent and status", () => {
    expect(parseCapture("fix login !0 #acme @claude-wt2 ^now")).toEqual({
      title: "fix login",
      priority: 0,
      project_name: "acme",
      agent: "claude-wt2",
      status: "in_progress",
    });
  });

  it("knows the review status", () => {
    expect(parseCapture("polish docs ^review").status).toBe("in_review");
  });

  it("treats a bare ! as P1", () => {
    expect(parseCapture("ship it !").priority).toBe(1);
  });

  it("splits the next step after a standalone >", () => {
    const t = parseCapture("refactor auth #api > read the token middleware first");
    expect(t.title).toBe("refactor auth");
    expect(t.project_name).toBe("api");
    expect(t.next_step).toBe("read the token middleware first");
  });

  it("does not split on > inside words", () => {
    expect(parseCapture("a->b mapping").title).toBe("a->b mapping");
  });

  it("pulls out links and keeps unknown ^tokens and mid-word symbols", () => {
    const t = parseCapture("review PR https://github.com/x/y/pull/1 ^foo C# notes");
    expect(t.link).toBe("https://github.com/x/y/pull/1");
    expect(t.title).toBe("review PR ^foo C# notes");
  });

  it("ignores out-of-range priorities", () => {
    expect(parseCapture("thing !7")).toEqual({ title: "thing !7" });
  });
});
