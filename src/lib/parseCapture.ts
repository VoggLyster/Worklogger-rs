import type { NewTask, Status } from "./api";

/**
 * Quick-capture syntax:
 *   !0..!3        priority (P0 = most urgent; `!` alone = P1)
 *   #project      project (created if it doesn't exist)
 *   @agent        agent / session label
 *   ^now ^wait ^review ^block ^later   status (default: up next)
 *   https://…     link
 *   > text        everything after a standalone ">" becomes the next step
 */
const STATUS_TOKENS: Record<string, Status> = {
  now: "in_progress",
  doing: "in_progress",
  wait: "waiting",
  waiting: "waiting",
  agent: "waiting",
  review: "in_review",
  pr: "in_review",
  block: "blocked",
  blocked: "blocked",
  later: "backlog",
  backlog: "backlog",
  next: "todo",
  todo: "todo",
  done: "done",
};

export function parseCapture(raw: string): NewTask {
  let text = raw.trim();
  const out: NewTask = { title: "" };

  const split = text.match(/(?:^|\s)>\s+(.*)$/);
  if (split) {
    out.next_step = split[1].trim();
    text = text.slice(0, split.index).trim();
  }

  const words: string[] = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    let m: RegExpMatchArray | null;
    if ((m = tok.match(/^!([0-3])?$/))) {
      out.priority = m[1] === undefined ? 1 : Number(m[1]);
    } else if ((m = tok.match(/^#([\p{L}\p{N}_\-./]+)$/u))) {
      out.project_name = m[1];
    } else if ((m = tok.match(/^@(\S+)$/))) {
      out.agent = m[1];
    } else if ((m = tok.match(/^\^(\w+)$/)) && STATUS_TOKENS[m[1].toLowerCase()]) {
      out.status = STATUS_TOKENS[m[1].toLowerCase()];
    } else if (/^https?:\/\/\S+$/.test(tok)) {
      out.link = tok;
    } else {
      words.push(tok);
    }
  }
  out.title = words.join(" ");
  return out;
}
