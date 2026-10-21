//! GitHub tracking through the GitHub CLI (`gh`), using the user's existing `gh auth` login: pull requests
//! and issues linked to tasks. Tracked items are fetched with batched GraphQL queries; snapshots are cached in SQLite.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct GhRef {
    pub owner: String,
    pub name: String,
    pub number: i64,
}

impl GhRef {
    pub fn repo(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
    pub fn label(&self) -> String {
        format!("{}#{}", self.repo(), self.number)
    }
}

fn valid_ident(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Pr,
    Issue,
}

/// Accepts `https://github.com/owner/repo/{pull,issues}/123[/...]` (kind known) or `owner/repo#123`
/// (kind unknown: GitHub numbers PRs and issues in one sequence, so it has to be looked up).
pub fn parse_ref(input: &str) -> Option<(GhRef, Option<Kind>)> {
    let s = input.trim();
    let (owner, name, num, kind) = if let Some(rest) = s
        .strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("http://github.com/"))
        .or_else(|| s.strip_prefix("github.com/"))
    {
        let mut parts = rest.split('/');
        let owner = parts.next()?;
        let name = parts.next()?;
        let kind = match parts.next()? {
            "pull" => Kind::Pr,
            "issues" => Kind::Issue,
            _ => return None,
        };
        let num = parts.next()?.split(['?', '#']).next()?;
        (owner, name, num, Some(kind))
    } else {
        let (repo, num) = s.split_once('#')?;
        let (owner, name) = repo.split_once('/')?;
        (owner, name, num, None)
    };
    let number: i64 = num.parse().ok().filter(|n| *n > 0)?;
    (valid_ident(owner) && valid_ident(name)).then(|| (GhRef { owner: owner.into(), name: name.into(), number }, kind))
}

/// A PR URL or `owner/repo#123`.
pub fn parse_pr(input: &str) -> Option<GhRef> {
    parse_ref(input).filter(|(_, k)| *k != Some(Kind::Issue)).map(|(r, _)| r)
}

/// An issue URL or `owner/repo#123`.
pub fn parse_issue(input: &str) -> Option<GhRef> {
    parse_ref(input).filter(|(_, k)| *k != Some(Kind::Pr)).map(|(r, _)| r)
}

// ---------------------------------------------------------------- snapshot

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Comment {
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Review {
    pub author: String,
    pub state: String,
    pub body: String,
    pub submitted_at: String,
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Thread {
    pub path: String,
    pub line: Option<i64>,
    pub resolved: bool,
    pub outdated: bool,
    pub comments: Vec<Comment>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Check {
    pub name: String,
    /// SUCCESS | FAILURE | PENDING | NEUTRAL | SKIPPED | CANCELLED | ...
    pub result: String,
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PrSnapshot {
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    /// OPEN | CLOSED | MERGED
    pub state: String,
    pub is_draft: bool,
    pub author: String,
    pub head: String,
    pub base: String,
    pub additions: i64,
    pub deletions: i64,
    pub updated_at: String,
    pub merged_at: Option<String>,
    /// APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
    pub review_decision: Option<String>,
    /// MERGEABLE | CONFLICTING | UNKNOWN
    pub mergeable: String,
    /// Rollup: SUCCESS | FAILURE | PENDING | ERROR | EXPECTED | null (no checks)
    pub checks_state: Option<String>,
    pub checks: Vec<Check>,
    pub comment_count: i64,
    pub comments: Vec<Comment>,
    pub reviews: Vec<Review>,
    pub threads: Vec<Thread>,
    pub review_requests: Vec<String>,
    /// The `gh` user, to tell "my" comments from others'.
    pub viewer: String,
}

impl PrSnapshot {
    pub fn unresolved(&self) -> usize {
        self.threads.iter().filter(|t| !t.resolved).count()
    }

    /// One line for summaries.
    pub fn digest_line(&self) -> String {
        let mut bits = vec![if self.is_draft && self.state == "OPEN" { "draft".to_string() } else { self.state.to_lowercase() }];
        if let Some(d) = &self.review_decision {
            bits.push(format!("review: {}", d.to_lowercase().replace('_', " ")));
        }
        if let Some(c) = &self.checks_state {
            bits.push(format!("checks: {}", c.to_lowercase()));
        }
        if self.unresolved() > 0 {
            bits.push(format!("{} unresolved review threads", self.unresolved()));
        }
        if self.state == "OPEN" && self.mergeable == "CONFLICTING" {
            bits.push("merge conflicts".into());
        }
        format!("PR {}#{} \"{}\": {}", self.repo, self.number, self.title, bits.join(", "))
    }
}

const FRAGMENT: &str = r#"
fragment F on PullRequest {
  number title url state isDraft mergedAt updatedAt headRefName baseRefName additions deletions
  reviewDecision mergeable author { login } repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 60) { nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl }
    ... on StatusContext { context state targetUrl }
  } } } } } }
  comments(last: 20) { totalCount nodes { author { login } body createdAt url } }
  reviews(last: 20) { nodes { author { login } state body submittedAt url } }
  reviewThreads(first: 60) { nodes { isResolved isOutdated path line
    comments(first: 15) { nodes { author { login } body createdAt url } } } }
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
}"#;

const ISSUE_FRAGMENT: &str = r#"
fragment F on Issue {
  number title url state stateReason body updatedAt closedAt author { login } repository { nameWithOwner }
  labels(first: 20) { nodes { name color } }
  assignees(first: 10) { nodes { login } }
  milestone { title }
  comments(last: 20) { totalCount nodes { author { login } body createdAt url } }
  closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes {
    number title url state repository { nameWithOwner } } }
}"#;

/// One aliased `repository { <field>(number) }` lookup per ref, sharing the `F` fragment.
fn build_batch_query(refs: &[GhRef], field: &str, fragment: &str) -> String {
    let mut q = String::from("query {\n  viewer { login }\n");
    for (i, p) in refs.iter().enumerate() {
        // Identifiers are validated when parsed, so interpolation is safe.
        q.push_str(&format!(
            "  p{i}: repository(owner: \"{}\", name: \"{}\") {{ {field}(number: {}) {{ ...F }} }}\n",
            p.owner, p.name, p.number
        ));
    }
    q.push('}');
    q.push_str(fragment);
    q
}

#[cfg(test)]
pub fn build_query(prs: &[GhRef]) -> String {
    build_batch_query(prs, "pullRequest", FRAGMENT)
}

#[cfg(test)]
pub fn build_issue_query(issues: &[GhRef]) -> String {
    build_batch_query(issues, "issue", ISSUE_FRAGMENT)
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}
fn login(v: &Value) -> String {
    v.get("author").and_then(|a| a.get("login")).and_then(Value::as_str).unwrap_or("ghost").to_string()
}
fn nodes<'a>(v: &'a Value, path: &[&str]) -> Vec<&'a Value> {
    let mut cur = v;
    for p in path {
        match cur.get(p) {
            Some(n) => cur = n,
            None => return vec![],
        }
    }
    cur.get("nodes").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default()
}
fn comment(v: &Value) -> Comment {
    Comment { author: login(v), body: s(v, "body"), created_at: s(v, "createdAt"), url: s(v, "url") }
}

pub fn parse_snapshot(pr: &Value, viewer: &str) -> PrSnapshot {
    let rollup = nodes(pr, &["commits"])
        .first()
        .and_then(|n| n.get("commit"))
        .and_then(|c| c.get("statusCheckRollup"))
        .filter(|r| !r.is_null());
    let checks = rollup
        .map(|r| {
            nodes(r, &["contexts"])
                .into_iter()
                .map(|c| {
                    if c.get("__typename").and_then(Value::as_str) == Some("CheckRun") {
                        let status = s(c, "status");
                        let conclusion = s(c, "conclusion");
                        let result = if status != "COMPLETED" || conclusion.is_empty() { "PENDING".into() } else { conclusion };
                        Check { name: s(c, "name"), result, url: s(c, "detailsUrl") }
                    } else {
                        let st = s(c, "state");
                        let result = match st.as_str() {
                            "ERROR" => "FAILURE".into(),
                            "EXPECTED" => "PENDING".into(),
                            _ => st,
                        };
                        Check { name: s(c, "context"), result, url: s(c, "targetUrl") }
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    PrSnapshot {
        repo: pr.get("repository").map(|r| s(r, "nameWithOwner")).unwrap_or_default(),
        number: pr.get("number").and_then(Value::as_i64).unwrap_or_default(),
        title: s(pr, "title"),
        url: s(pr, "url"),
        state: s(pr, "state"),
        is_draft: pr.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        author: login(pr),
        head: s(pr, "headRefName"),
        base: s(pr, "baseRefName"),
        additions: pr.get("additions").and_then(Value::as_i64).unwrap_or_default(),
        deletions: pr.get("deletions").and_then(Value::as_i64).unwrap_or_default(),
        updated_at: s(pr, "updatedAt"),
        merged_at: pr.get("mergedAt").and_then(Value::as_str).map(String::from),
        review_decision: pr.get("reviewDecision").and_then(Value::as_str).map(String::from),
        mergeable: s(pr, "mergeable"),
        checks_state: rollup.and_then(|r| r.get("state")).and_then(Value::as_str).map(String::from),
        checks,
        comment_count: pr.get("comments").and_then(|c| c.get("totalCount")).and_then(Value::as_i64).unwrap_or_default(),
        comments: nodes(pr, &["comments"]).into_iter().map(comment).collect(),
        reviews: nodes(pr, &["reviews"])
            .into_iter()
            .map(|r| Review {
                author: login(r),
                state: s(r, "state"),
                body: s(r, "body"),
                submitted_at: s(r, "submittedAt"),
                url: s(r, "url"),
            })
            .collect(),
        threads: nodes(pr, &["reviewThreads"])
            .into_iter()
            .map(|t| Thread {
                path: s(t, "path"),
                line: t.get("line").and_then(Value::as_i64),
                resolved: t.get("isResolved").and_then(Value::as_bool).unwrap_or(false),
                outdated: t.get("isOutdated").and_then(Value::as_bool).unwrap_or(false),
                comments: nodes(t, &["comments"]).into_iter().map(comment).collect(),
            })
            .collect(),
        review_requests: nodes(pr, &["reviewRequests"])
            .into_iter()
            .filter_map(|n| n.get("requestedReviewer"))
            .filter_map(|r| r.get("login").or_else(|| r.get("name")).and_then(Value::as_str))
            .map(String::from)
            .collect(),
        viewer: viewer.to_string(),
    }
}

// ---------------------------------------------------------------- change detection

/// Notable changes between two snapshots of the same PR, as short human-readable lines.
pub fn diff_events(old: &PrSnapshot, new: &PrSnapshot) -> Vec<(&'static str, String)> {
    let mut ev = Vec::new();
    match (old.state.as_str(), new.state.as_str()) {
        (a, "MERGED") if a != "MERGED" => ev.push(("merged", "Merged".to_string())),
        ("OPEN", "CLOSED") => ev.push(("closed", "Closed without merging".to_string())),
        ("CLOSED", "OPEN") => ev.push(("reopened", "Reopened".to_string())),
        _ => {}
    }
    if new.state == "OPEN" {
        if old.is_draft && !new.is_draft {
            ev.push(("ready", "Marked ready for review".into()));
        } else if !old.is_draft && new.is_draft {
            ev.push(("draft", "Converted to draft".into()));
        }
        if old.checks_state != new.checks_state {
            match new.checks_state.as_deref() {
                Some("FAILURE") | Some("ERROR") => {
                    let failed: Vec<&str> =
                        new.checks.iter().filter(|c| c.result == "FAILURE" || c.result == "TIMED_OUT").map(|c| c.name.as_str()).collect();
                    let detail = if failed.is_empty() { String::new() } else { format!(": {}", failed.join(", ")) };
                    ev.push(("checks_failed", format!("Checks failing{detail}")));
                }
                Some("SUCCESS") => ev.push(("checks_passed", "Checks passing".into())),
                _ => {}
            }
        }
        if old.review_decision != new.review_decision {
            match new.review_decision.as_deref() {
                Some("APPROVED") => ev.push(("approved", "Approved".into())),
                Some("CHANGES_REQUESTED") => ev.push(("changes_requested", "Changes requested".into())),
                _ => {}
            }
        }
        if old.mergeable != "CONFLICTING" && new.mergeable == "CONFLICTING" {
            ev.push(("conflict", "Has merge conflicts".into()));
        }
    }

    // New comments / reviews from other people.
    let seen: HashSet<&str> = old
        .comments
        .iter()
        .chain(old.threads.iter().flat_map(|t| t.comments.iter()))
        .map(|c| c.url.as_str())
        .chain(old.reviews.iter().map(|r| r.url.as_str()))
        .collect();
    let mut authors: Vec<String> = Vec::new();
    let mut count = 0;
    let fresh_comments = new.comments.iter().chain(new.threads.iter().flat_map(|t| t.comments.iter()));
    for c in fresh_comments {
        if !seen.contains(c.url.as_str()) && c.author != new.viewer {
            count += 1;
            if !authors.contains(&c.author) {
                authors.push(c.author.clone());
            }
        }
    }
    for r in &new.reviews {
        // Reviews without a body are already covered by their thread comments or the decision.
        if !seen.contains(r.url.as_str()) && r.author != new.viewer && !r.body.trim().is_empty() {
            count += 1;
            if !authors.contains(&r.author) {
                authors.push(r.author.clone());
            }
        }
    }
    if count > 0 {
        let noun = if count == 1 { "comment" } else { "comments" };
        ev.push(("comments", format!("{count} new {noun} from {}", authors.join(", "))));
    }
    ev
}

// ---------------------------------------------------------------- issues

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Label {
    pub name: String,
    /// Hex without '#'.
    pub color: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ClosingPr {
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct IssueSnapshot {
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    /// OPEN | CLOSED
    pub state: String,
    /// COMPLETED | NOT_PLANNED | REOPENED | DUPLICATE | null
    pub state_reason: Option<String>,
    pub author: String,
    /// First part of the issue body (Markdown).
    pub body: String,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
    pub milestone: Option<String>,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub comment_count: i64,
    pub comments: Vec<Comment>,
    /// PRs that will close (or closed) this issue.
    pub closing_prs: Vec<ClosingPr>,
    pub viewer: String,
}

impl IssueSnapshot {
    /// Closed as done (not "not planned" / duplicate).
    pub fn completed(&self) -> bool {
        self.state == "CLOSED" && !matches!(self.state_reason.as_deref(), Some("NOT_PLANNED") | Some("DUPLICATE"))
    }

    pub fn digest_line(&self) -> String {
        let mut bits = vec![match (self.state.as_str(), self.completed()) {
            ("OPEN", _) => "open".to_string(),
            (_, true) => "closed as completed".to_string(),
            _ => "closed as not planned".to_string(),
        }];
        if !self.labels.is_empty() {
            bits.push(format!("labels: {}", self.labels.iter().map(|l| l.name.as_str()).collect::<Vec<_>>().join(", ")));
        }
        if !self.assignees.is_empty() {
            bits.push(format!("assigned: {}", self.assignees.join(", ")));
        }
        if self.comment_count > 0 {
            bits.push(format!("{} comments", self.comment_count));
        }
        format!("issue {}#{} \"{}\": {}", self.repo, self.number, self.title, bits.join(", "))
    }
}

const ISSUE_BODY_LIMIT: usize = 4000;

pub fn parse_issue_snapshot(v: &Value, viewer: &str) -> IssueSnapshot {
    let body: String = s(v, "body").chars().take(ISSUE_BODY_LIMIT).collect();
    IssueSnapshot {
        repo: v.get("repository").map(|r| s(r, "nameWithOwner")).unwrap_or_default(),
        number: v.get("number").and_then(Value::as_i64).unwrap_or_default(),
        title: s(v, "title"),
        url: s(v, "url"),
        state: s(v, "state"),
        state_reason: v.get("stateReason").and_then(Value::as_str).map(String::from),
        author: login(v),
        body,
        labels: nodes(v, &["labels"]).into_iter().map(|l| Label { name: s(l, "name"), color: s(l, "color") }).collect(),
        assignees: nodes(v, &["assignees"]).into_iter().map(|a| s(a, "login")).collect(),
        milestone: v.get("milestone").and_then(|m| m.get("title")).and_then(Value::as_str).map(String::from),
        updated_at: s(v, "updatedAt"),
        closed_at: v.get("closedAt").and_then(Value::as_str).map(String::from),
        comment_count: v.get("comments").and_then(|c| c.get("totalCount")).and_then(Value::as_i64).unwrap_or_default(),
        comments: nodes(v, &["comments"]).into_iter().map(comment).collect(),
        closing_prs: nodes(v, &["closedByPullRequestsReferences"])
            .into_iter()
            .map(|p| ClosingPr {
                repo: p.get("repository").map(|r| s(r, "nameWithOwner")).unwrap_or_default(),
                number: p.get("number").and_then(Value::as_i64).unwrap_or_default(),
                title: s(p, "title"),
                url: s(p, "url"),
                state: s(p, "state"),
            })
            .collect(),
        viewer: viewer.to_string(),
    }
}

/// Notable changes between two snapshots of the same issue.
pub fn diff_issue_events(old: &IssueSnapshot, new: &IssueSnapshot) -> Vec<(&'static str, String)> {
    let mut ev = Vec::new();
    match (old.state.as_str(), new.state.as_str()) {
        ("OPEN", "CLOSED") if new.completed() => ev.push(("closed", "Closed as completed".to_string())),
        ("OPEN", "CLOSED") => ev.push(("closed_not_planned", "Closed as not planned".to_string())),
        ("CLOSED", "OPEN") => ev.push(("reopened", "Reopened".to_string())),
        _ => {}
    }
    if !new.viewer.is_empty() && new.assignees.contains(&new.viewer) && !old.assignees.contains(&new.viewer) {
        ev.push(("assigned", "Assigned to you".to_string()));
    }
    let seen: HashSet<&str> = old.comments.iter().map(|c| c.url.as_str()).collect();
    let mut authors: Vec<String> = Vec::new();
    let mut count = 0;
    for c in &new.comments {
        if !seen.contains(c.url.as_str()) && c.author != new.viewer {
            count += 1;
            if !authors.contains(&c.author) {
                authors.push(c.author.clone());
            }
        }
    }
    if count > 0 {
        let noun = if count == 1 { "comment" } else { "comments" };
        ev.push(("comments", format!("{count} new {noun} from {}", authors.join(", "))));
    }
    ev
}

// ---------------------------------------------------------------- gh CLI

pub fn resolve_gh(setting: Option<String>) -> PathBuf {
    if let Some(p) = setting {
        return PathBuf::from(p);
    }
    #[cfg(windows)]
    {
        let p = Path::new(r"C:\Program Files\GitHub CLI\gh.exe");
        if p.exists() {
            return p.to_path_buf();
        }
    }
    // Bundled .app launches from Finder don't inherit the shell PATH, so fall back
    // to the common Homebrew locations before giving up to a bare "gh".
    #[cfg(target_os = "macos")]
    {
        for p in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"] {
            let p = Path::new(p);
            if p.exists() {
                return p.to_path_buf();
            }
        }
    }
    PathBuf::from("gh")
}

fn friendly(msg: &str) -> String {
    let lower = msg.to_lowercase();
    if lower.contains("gh auth login") || lower.contains("not logged") || lower.contains("authentication") {
        format!("GitHub CLI isn't logged in. Run `gh auth login` in a terminal. ({})", msg.trim())
    } else {
        msg.trim().to_string()
    }
}

async fn run_gh(gh: &Path, cwd: &Path, args: &[&str], stdin: Option<&str>, timeout_s: u64) -> Result<String, String> {
    let mut cmd = crate::cli::hidden_command(gh, cwd);
    cmd.args(args);
    if stdin.is_none() {
        cmd.stdin(std::process::Stdio::null());
    }
    let mut child = cmd.spawn().map_err(|e| {
        format!("Couldn't start the GitHub CLI at '{}': {e}. Install it from cli.github.com or set its path in Settings.", gh.display())
    })?;
    if let Some(input) = stdin {
        let mut w = child.stdin.take().ok_or("no stdin")?;
        w.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
        drop(w);
    }
    let out = tokio::time::timeout(Duration::from_secs(timeout_s), child.wait_with_output())
        .await
        .map_err(|_| "GitHub CLI timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() && stdout.trim().is_empty() {
        return Err(friendly(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(stdout)
}

async fn graphql(gh: &Path, cwd: &Path, query: &str) -> Result<Value, String> {
    let raw = run_gh(gh, cwd, &["api", "graphql", "-F", "query=@-"], Some(query), 60).await?;
    let v: Value = serde_json::from_str(raw.trim()).map_err(|e| format!("Unexpected gh output: {e}: {}", raw.trim()))?;
    match v.get("data").filter(|d| !d.is_null()) {
        Some(data) => Ok(data.clone()),
        None => {
            let msg = v.get("errors").and_then(|e| e.get(0)).and_then(|e| e.get("message")).and_then(Value::as_str);
            Err(friendly(msg.unwrap_or("GitHub returned no data")))
        }
    }
}

type Batch<T> = HashMap<GhRef, Result<T, String>>;

/// Fetch many items (chunked). Per-item failures (deleted repo, no access, wrong kind) come back as `Err`.
async fn fetch_batch<T>(
    gh: &Path,
    cwd: &Path,
    refs: &[GhRef],
    field: &str,
    fragment: &str,
    parse: fn(&Value, &str) -> T,
) -> Result<Batch<T>, String> {
    let mut out = HashMap::new();
    for chunk in refs.chunks(20) {
        let data = graphql(gh, cwd, &build_batch_query(chunk, field, fragment)).await?;
        let viewer = data.get("viewer").map(|u| s(u, "login")).unwrap_or_default();
        for (i, r) in chunk.iter().enumerate() {
            let item = data.get(format!("p{i}")).and_then(|x| x.get(field)).filter(|x| !x.is_null());
            out.insert(
                r.clone(),
                match item {
                    Some(item) => Ok(parse(item, &viewer)),
                    None => Err(format!("{} not found or no access", r.label())),
                },
            );
        }
    }
    Ok(out)
}

pub async fn fetch_prs(gh: &Path, cwd: &Path, prs: &[GhRef]) -> Result<Batch<PrSnapshot>, String> {
    fetch_batch(gh, cwd, prs, "pullRequest", FRAGMENT, parse_snapshot).await
}

pub async fn fetch_issues(gh: &Path, cwd: &Path, issues: &[GhRef]) -> Result<Batch<IssueSnapshot>, String> {
    fetch_batch(gh, cwd, issues, "issue", ISSUE_FRAGMENT, parse_issue_snapshot).await
}

/// For `owner/repo#123` input: ask GitHub whether the number is a PR or an issue.
pub async fn resolve_kind(gh: &Path, cwd: &Path, r: &GhRef) -> Result<Kind, String> {
    let q = format!(
        "query {{ repository(owner: \"{}\", name: \"{}\") {{ issueOrPullRequest(number: {}) {{ __typename }} }} }}",
        r.owner, r.name, r.number
    );
    let data = graphql(gh, cwd, &q).await?;
    match data.get("repository").and_then(|x| x.get("issueOrPullRequest")).and_then(|x| x.get("__typename")).and_then(Value::as_str) {
        Some("PullRequest") => Ok(Kind::Pr),
        Some("Issue") => Ok(Kind::Issue),
        _ => Err(format!("{} not found or no access", r.label())),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchIssue {
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
    pub author: String,
    pub comment_count: i64,
    pub updated_at: String,
}

/// Which issues to list: those involving the viewer (default), assigned/created/mentioning them,
/// or every open issue in one repo.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueScope {
    Involves,
    Assigned,
    Created,
    Mentioned,
    Repo,
}

pub async fn search_issues(gh: &Path, cwd: &Path, scope: IssueScope, repo: Option<&str>, query: &str) -> Result<Vec<SearchIssue>, String> {
    let mut args: Vec<String> = vec!["search".into(), "issues".into()];
    let q = query.trim();
    if !q.is_empty() {
        args.push(q.into());
    }
    match scope {
        IssueScope::Involves => args.extend(["--involves".into(), "@me".into()]),
        IssueScope::Assigned => args.extend(["--assignee".into(), "@me".into()]),
        IssueScope::Created => args.extend(["--author".into(), "@me".into()]),
        IssueScope::Mentioned => args.extend(["--mentions".into(), "@me".into()]),
        IssueScope::Repo => {
            let repo = repo.filter(|r| r.split_once('/').is_some_and(|(o, n)| valid_ident(o) && valid_ident(n)));
            let repo = repo.ok_or("Pick a repository (owner/name) to browse")?;
            args.extend(["--repo".into(), repo.into()]);
        }
    }
    args.extend(
        ["--state", "open", "--sort", "updated", "--limit", "100", "--json", "number,title,repository,url,state,labels,assignees,author,commentsCount,updatedAt,isPullRequest"]
            .map(String::from),
    );
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let raw = run_gh(gh, cwd, &argv, None, 45).await?;
    let v: Value = serde_json::from_str(raw.trim()).map_err(|e| format!("Unexpected gh output: {e}"))?;
    Ok(v.as_array()
        .map(|a| {
            a.iter()
                .filter(|i| !i.get("isPullRequest").and_then(Value::as_bool).unwrap_or(false))
                .map(|i| SearchIssue {
                    repo: i.get("repository").map(|r| s(r, "nameWithOwner")).unwrap_or_default(),
                    number: i.get("number").and_then(Value::as_i64).unwrap_or_default(),
                    title: s(i, "title"),
                    url: s(i, "url"),
                    state: s(i, "state").to_uppercase(),
                    labels: i
                        .get("labels")
                        .and_then(Value::as_array)
                        .map(|ls| ls.iter().map(|l| Label { name: s(l, "name"), color: s(l, "color") }).collect())
                        .unwrap_or_default(),
                    assignees: i
                        .get("assignees")
                        .and_then(Value::as_array)
                        .map(|xs| xs.iter().map(|x| s(x, "login")).collect())
                        .unwrap_or_default(),
                    author: login(i),
                    comment_count: i.get("commentsCount").and_then(Value::as_i64).unwrap_or_default(),
                    updated_at: s(i, "updatedAt"),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchPr {
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub is_draft: bool,
    pub updated_at: String,
}

/// The viewer's open PRs across all repos.
pub async fn my_open_prs(gh: &Path, cwd: &Path) -> Result<Vec<SearchPr>, String> {
    let raw = run_gh(
        gh,
        cwd,
        &["search", "prs", "--author", "@me", "--state", "open", "--limit", "100", "--json", "number,title,repository,url,isDraft,updatedAt"],
        None,
        45,
    )
    .await?;
    let v: Value = serde_json::from_str(raw.trim()).map_err(|e| format!("Unexpected gh output: {e}"))?;
    Ok(v.as_array()
        .map(|a| {
            a.iter()
                .map(|p| SearchPr {
                    repo: p.get("repository").map(|r| s(r, "nameWithOwner")).unwrap_or_default(),
                    number: p.get("number").and_then(Value::as_i64).unwrap_or_default(),
                    title: s(p, "title"),
                    url: s(p, "url"),
                    is_draft: p.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
                    updated_at: s(p, "updatedAt"),
                })
                .collect()
        })
        .unwrap_or_default())
}

pub async fn auth_status(gh: &Path, cwd: &Path) -> Result<String, String> {
    let raw = run_gh(gh, cwd, &["api", "user", "--jq", ".login"], None, 20).await?;
    let login = raw.trim();
    if login.is_empty() { Err("GitHub CLI returned no user".into()) } else { Ok(format!("Logged in as {login}")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Hits GitHub through the real `gh`. Point it at any PR you can read:
    /// `WORKLOGGER_LIVE_PR=owner/repo#123 cargo test -- --ignored live_gh --nocapture`
    #[test]
    #[ignore]
    fn live_gh_fetch() {
        let Some(pr) = std::env::var("WORKLOGGER_LIVE_PR").ok().and_then(|v| parse_pr(&v)) else {
            println!("skipped: set WORKLOGGER_LIVE_PR=owner/repo#123");
            return;
        };
        let missing = GhRef { number: 999_999_999, ..pr.clone() };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let gh = resolve_gh(None);
        let cwd = std::env::temp_dir();
        let prs = vec![pr.clone(), missing.clone()];
        let out = rt.block_on(fetch_prs(&gh, &cwd, &prs)).expect("gh call");
        for p in &prs {
            match &out[p] {
                Ok(s) => println!("{} -> {} | {} checks | {} comments | {} threads ({} unresolved)", p.label(), s.digest_line(), s.checks.len(), s.comments.len(), s.threads.len(), s.unresolved()),
                Err(e) => println!("{} -> ERR {e}", p.label()),
            }
        }
        assert!(out[&pr].is_ok() && out[&missing].is_err());
        let mine = rt.block_on(my_open_prs(&gh, &cwd)).expect("search");
        println!("{} open PRs authored by viewer", mine.len());
        println!("{}", rt.block_on(auth_status(&gh, &cwd)).unwrap());
    }

    /// Issues end-to-end: search, kind lookup, batch fetch.
    /// `cargo test -- --ignored live_issues --nocapture` (uses the first open issue involving you)
    #[test]
    #[ignore]
    fn live_issues() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let gh = resolve_gh(None);
        let cwd = std::env::temp_dir();
        let found = rt.block_on(search_issues(&gh, &cwd, IssueScope::Involves, None, "")).expect("search");
        println!("{} open issues involve you", found.len());
        let Some(first) = found.first() else { return };
        let r = parse_issue(&format!("{}#{}", first.repo, first.number)).unwrap();
        assert_eq!(rt.block_on(resolve_kind(&gh, &cwd, &r)).unwrap(), Kind::Issue);
        let out = rt.block_on(fetch_issues(&gh, &cwd, std::slice::from_ref(&r))).expect("fetch");
        let snap = out[&r].as_ref().expect("issue snapshot");
        println!("state {} | {} labels | {} comments | {} closing PRs", snap.state, snap.labels.len(), snap.comment_count, snap.closing_prs.len());
        assert_eq!(snap.number, r.number);
        let by_repo = rt.block_on(search_issues(&gh, &cwd, IssueScope::Repo, Some(&first.repo), "")).expect("repo search");
        assert!(by_repo.iter().all(|i| i.repo.eq_ignore_ascii_case(&first.repo)));
    }

    #[test]
    fn parses_issue_and_ambiguous_references() {
        let (r, k) = parse_ref("https://github.com/acme/widgets/issues/12#issuecomment-1").unwrap();
        assert_eq!((r.number, k), (12, Some(Kind::Issue)));
        assert_eq!(parse_ref("acme/widgets#12").unwrap().1, None, "short form needs a lookup");
        assert!(parse_pr("https://github.com/acme/widgets/issues/12").is_none());
        assert!(parse_issue("https://github.com/acme/widgets/pull/12").is_none());
        assert_eq!(parse_issue("acme/widgets#12").unwrap().number, 12);
        let q = build_issue_query(&[r]);
        assert!(q.contains("issue(number: 12)") && q.contains("fragment F on Issue"));
    }

    fn issue_sample() -> Value {
        json!({
            "number": 12, "title": "Crash on save", "url": "https://github.com/acme/widgets/issues/12",
            "state": "OPEN", "stateReason": null, "body": "Steps:\n1. save", "updatedAt": "t", "closedAt": null,
            "author": {"login": "alex"}, "repository": {"nameWithOwner": "acme/widgets"},
            "labels": {"nodes": [{"name": "bug", "color": "d73a4a"}]},
            "assignees": {"nodes": []},
            "milestone": {"title": "v2"},
            "comments": {"totalCount": 1, "nodes": [{"author": {"login": "alex"}, "body": "still happens", "createdAt": "t", "url": "c1"}]},
            "closedByPullRequestsReferences": {"nodes": [{"number": 40, "title": "Fix save", "url": "u", "state": "OPEN", "repository": {"nameWithOwner": "acme/widgets"}}]}
        })
    }

    #[test]
    fn parses_issue_snapshot() {
        let i = parse_issue_snapshot(&issue_sample(), "me");
        assert_eq!((i.repo.as_str(), i.number, i.state.as_str()), ("acme/widgets", 12, "OPEN"));
        assert_eq!(i.labels[0].name, "bug");
        assert_eq!(i.milestone.as_deref(), Some("v2"));
        assert_eq!(i.closing_prs[0].number, 40);
        assert!(i.digest_line().contains("open, labels: bug, 1 comments"));
        assert!(!i.completed());
    }

    #[test]
    fn issue_diff_detects_close_assign_and_comments() {
        let old = parse_issue_snapshot(&issue_sample(), "me");
        assert!(diff_issue_events(&old, &old).is_empty());

        let mut new = old.clone();
        new.assignees.push("me".into());
        new.comments.push(Comment { author: "sam".into(), url: "c2".into(), ..Default::default() });
        new.comments.push(Comment { author: "me".into(), url: "c3".into(), ..Default::default() });
        let ev: Vec<_> = diff_issue_events(&old, &new);
        assert_eq!(ev.iter().map(|e| e.0).collect::<Vec<_>>(), vec!["assigned", "comments"]);
        assert_eq!(ev[1].1, "1 new comment from sam");

        let mut closed = old.clone();
        closed.state = "CLOSED".into();
        closed.state_reason = Some("NOT_PLANNED".into());
        assert_eq!(diff_issue_events(&old, &closed)[0].0, "closed_not_planned");
        assert!(!closed.completed());
        closed.state_reason = Some("COMPLETED".into());
        assert_eq!(diff_issue_events(&old, &closed)[0].0, "closed");
        assert_eq!(diff_issue_events(&closed, &old)[0].0, "reopened");
    }

    #[test]
    fn parses_pr_references() {
        let p = parse_pr("https://github.com/acme/widgets/pull/475/files?x=1").unwrap();
        assert_eq!((p.owner.as_str(), p.name.as_str(), p.number), ("acme", "widgets", 475));
        assert_eq!(parse_pr("acme/e2e-tests#7").unwrap().number, 7);
        assert_eq!(parse_pr("github.com/a/b.c/pull/3").unwrap().name, "b.c");
        assert!(parse_pr("https://github.com/a/b/issues/3").is_none());
        assert!(parse_pr("https://github.com/a/b/pull/0").is_none());
        assert!(parse_pr("a\"){ evil }/b#1").is_none(), "rejects anything that could break the query");
        assert!(parse_pr("just text").is_none());
    }

    #[test]
    fn query_has_one_alias_per_pr() {
        let q = build_query(&[parse_pr("a/b#1").unwrap(), parse_pr("c/d#2").unwrap()]);
        assert!(q.contains("p0: repository(owner: \"a\", name: \"b\") { pullRequest(number: 1)"));
        assert!(q.contains("p1: repository(owner: \"c\", name: \"d\") { pullRequest(number: 2)"));
        assert!(q.contains("viewer { login }") && q.contains("fragment F on PullRequest"));
    }

    fn sample() -> Value {
        json!({
            "number": 475, "title": "Fix banks", "url": "https://github.com/o/r/pull/475", "state": "OPEN",
            "isDraft": false, "mergedAt": null, "updatedAt": "2026-10-20T11:20:33Z", "headRefName": "fix/banks",
            "baseRefName": "main", "additions": 138, "deletions": 35, "reviewDecision": "REVIEW_REQUIRED",
            "mergeable": "MERGEABLE", "author": {"login": "me"}, "repository": {"nameWithOwner": "o/r"},
            "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "FAILURE", "contexts": {"nodes": [
                {"__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "u1"},
                {"__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS", "conclusion": null, "detailsUrl": "u2"},
                {"__typename": "StatusContext", "context": "ci/legacy", "state": "ERROR", "targetUrl": "u3"}
            ]}}}}]},
            "comments": {"totalCount": 1, "nodes": [{"author": {"login": "bob"}, "body": "hi", "createdAt": "t", "url": "c1"}]},
            "reviews": {"nodes": [{"author": {"login": "copilot"}, "state": "COMMENTED", "body": "", "submittedAt": "t", "url": "r1"}]},
            "reviewThreads": {"nodes": [
                {"isResolved": false, "isOutdated": false, "path": "a.cs", "line": 10, "comments": {"nodes": [{"author": {"login": "copilot"}, "body": "x", "createdAt": "t", "url": "tc1"}]}},
                {"isResolved": true, "isOutdated": true, "path": "b.cs", "line": null, "comments": {"nodes": []}}
            ]},
            "reviewRequests": {"nodes": [{"requestedReviewer": {"login": "alice"}}, {"requestedReviewer": {"name": "core"}}]}
        })
    }

    #[test]
    fn parses_snapshot() {
        let p = parse_snapshot(&sample(), "me");
        assert_eq!(p.repo, "o/r");
        assert_eq!(p.checks_state.as_deref(), Some("FAILURE"));
        let results: Vec<&str> = p.checks.iter().map(|c| c.result.as_str()).collect();
        assert_eq!(results, vec!["FAILURE", "PENDING", "FAILURE"]);
        assert_eq!(p.unresolved(), 1);
        assert_eq!(p.review_requests, vec!["alice", "core"]);
        assert_eq!(p.threads[1].line, None);
        assert!(p.digest_line().contains("checks: failure") && p.digest_line().contains("1 unresolved"));
        let mut merged = p.clone();
        merged.state = "MERGED".into();
        merged.mergeable = "CONFLICTING".into();
        assert!(!merged.digest_line().contains("conflicts"), "stale conflict flag on merged PRs is ignored");
    }

    #[test]
    fn parses_pr_without_checks() {
        let mut v = sample();
        v["commits"] = json!({"nodes": [{"commit": {"statusCheckRollup": null}}]});
        let p = parse_snapshot(&v, "me");
        assert_eq!(p.checks_state, None);
        assert!(p.checks.is_empty());
    }

    #[test]
    fn diff_detects_notable_changes() {
        let old = parse_snapshot(&sample(), "me");
        let mut new = old.clone();
        assert!(diff_events(&old, &new).is_empty(), "no change, no events");

        new.checks_state = Some("SUCCESS".into());
        new.review_decision = Some("APPROVED".into());
        new.threads[0].comments.push(Comment { author: "alice".into(), url: "tc2".into(), ..Default::default() });
        new.comments.push(Comment { author: "me".into(), url: "c2".into(), ..Default::default() });
        let kinds: Vec<_> = diff_events(&old, &new).into_iter().map(|e| e.0).collect();
        assert_eq!(kinds, vec!["checks_passed", "approved", "comments"]);
        assert_eq!(diff_events(&old, &new)[2].1, "1 new comment from alice", "own comments are ignored");

        let mut merged = old.clone();
        merged.state = "MERGED".into();
        merged.checks_state = Some("SUCCESS".into());
        let kinds: Vec<_> = diff_events(&old, &merged).into_iter().map(|e| e.0).collect();
        assert_eq!(kinds, vec!["merged"], "merged PRs don't report check changes");
    }

    #[test]
    fn failing_checks_are_named() {
        let mut old = parse_snapshot(&sample(), "me");
        old.checks_state = Some("PENDING".into());
        let new = parse_snapshot(&sample(), "me");
        assert_eq!(diff_events(&old, &new)[0].1, "Checks failing: build, ci/legacy");
    }
}
