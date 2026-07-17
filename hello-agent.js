#!/usr/bin/env node
// Fetches Linear issue(s), writes their details to markdown files inside a
// target repo, commits, pushes a branch per issue, and opens a GitHub PR.
// This tool's own code is never committed to the target repo -- only the
// generated ticket files are.
//
// Single-issue usage:
//   node hello-agent.js --repo <path> [LIN-123|linear-url] [--base <branch>] [--team <TEAM_KEY>]
//   (omit the issue ref to use the most recently created issue)
//
// Poll usage (checks for any issues without an existing PR yet, processes them all):
//   node hello-agent.js --poll --repo <path> [--base <branch>] [--team <TEAM_KEY>] [--limit <n>]
//
// Required env vars: LINEAR_API_KEY, GITHUB_TOKEN
// Repo path can also be set via REPO_PATH env var, team via LINEAR_TEAM_KEY.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function loadDotEnv() {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function fail(message) {
  console.error(`hello-agent: ${message}`);
  process.exit(1);
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd }).trim();
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { base: null, repo: null, team: null, limit: 20, poll: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base") opts.base = args[++i];
    else if (args[i] === "--repo") opts.repo = args[++i];
    else if (args[i] === "--team") opts.team = args[++i];
    else if (args[i] === "--limit") opts.limit = Number(args[++i]);
    else if (args[i] === "--poll") opts.poll = true;
    else positional.push(args[i]);
  }
  opts.issueRef = positional[0] ?? null;
  return opts;
}

function extractIdentifier(ref) {
  // Accepts a bare identifier ("LIN-123") or a Linear issue URL
  // (https://linear.app/<team>/issue/LIN-123/some-slug).
  const urlMatch = ref.match(/linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  const bareMatch = ref.match(/^([A-Za-z]+-\d+)$/);
  if (bareMatch) return bareMatch[1].toUpperCase();
  fail(`could not parse a Linear issue identifier from "${ref}"`);
}

async function linearGraphQL(apiKey, query, variables) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    fail(`Linear API request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.errors) {
    fail(`Linear API error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data;
}

async function fetchLinearIssue(identifier, apiKey) {
  const query = `
    query IssueByIdentifier($id: String!) {
      issue(id: $id) {
        identifier
        title
        description
        url
      }
    }
  `;
  const data = await linearGraphQL(apiKey, query, { id: identifier });
  if (!data?.issue) fail(`Linear issue "${identifier}" not found`);
  return data.issue;
}

async function fetchRecentLinearIssues(apiKey, { teamKey, limit }) {
  const query = `
    query RecentIssues($first: Int!, $filter: IssueFilter) {
      issues(first: $first, orderBy: createdAt, filter: $filter) {
        nodes {
          identifier
          title
          description
          url
          createdAt
        }
      }
    }
  `;
  const filter = teamKey ? { team: { key: { eq: teamKey } } } : undefined;
  const data = await linearGraphQL(apiKey, query, { first: limit, filter });
  return data?.issues?.nodes ?? [];
}

async function fetchLatestLinearIssue(apiKey, { teamKey }) {
  const issues = await fetchRecentLinearIssues(apiKey, { teamKey, limit: 1 });
  if (!issues[0]) fail(teamKey ? `no Linear issues found for team "${teamKey}"` : "no Linear issues found for this API key");
  return issues[0];
}

function parseOwnerRepo(remoteUrl) {
  // Handles SSH (git@host:owner/repo.git, incl. custom Host aliases) and
  // HTTPS remote URL forms (including token-embedded https://x:TOKEN@host/owner/repo.git).
  const sshMatch = remoteUrl.match(/^git@[^:]+:([^/]+)\/(.+?)(\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  const httpsMatch = remoteUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  fail(`could not parse owner/repo from remote URL "${remoteUrl}"`);
}

async function githubApi(path, token, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    fail(`GitHub API ${options.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText}\n${body}`);
  }
  return res.json();
}

async function prAlreadyExists(owner, repo, branchName, token) {
  const prs = await githubApi(`/repos/${owner}/${repo}/pulls?state=all&head=${owner}:${branchName}`, token);
  return prs.length > 0;
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function buildMarkdown(issue) {
  const description = issue.description?.trim() || "_No description provided._";
  return `# ${issue.identifier}: ${issue.title}

**Linear issue:** ${issue.url}
**Issue ID:** ${issue.identifier}

## Description

${description}

---

Hello world from agent
`;
}

function ensureBaseBranch(repoPath, base) {
  const remoteHeads = run("git", ["ls-remote", "--heads", "origin", base], repoPath);
  if (!remoteHeads) {
    console.log(`Base branch "${base}" doesn't exist on origin yet -- bootstrapping it with an empty initial commit...`);
    run("git", ["checkout", "--orphan", base], repoPath);
    run("git", ["commit", "--allow-empty", "-m", "Initial commit"], repoPath);
    run("git", ["push", "origin", base], repoPath);
  }
  run("git", ["fetch", "origin", base], repoPath);
}

async function processIssue(issue, { repoPath, owner, repo, base, githubToken }) {
  const branchName = `hello-agent/${issue.identifier.toLowerCase()}`;

  if (await prAlreadyExists(owner, repo, branchName, githubToken)) {
    console.log(`Skipping ${issue.identifier}: a PR already exists for branch ${branchName}`);
    return null;
  }

  run("git", ["checkout", "-B", base, `origin/${base}`], repoPath);
  run("git", ["checkout", "-B", branchName], repoPath);

  const slug = slugify(issue.title);
  const relativeFilePath = join("tickets", `${issue.identifier.toLowerCase()}-${slug}.md`);
  const absoluteFilePath = join(repoPath, relativeFilePath);
  mkdirSync(dirname(absoluteFilePath), { recursive: true });
  writeFileSync(absoluteFilePath, buildMarkdown(issue));
  console.log(`Wrote ${relativeFilePath} in ${repoPath}`);

  run("git", ["add", relativeFilePath], repoPath);
  run("git", ["commit", "-m", `Add ${issue.identifier}: ${issue.title}`], repoPath);
  run("git", ["push", "-u", "origin", branchName, "--force-with-lease"], repoPath);

  console.log(`Opening pull request for ${issue.identifier}...`);
  const pr = await githubApi(`/repos/${owner}/${repo}/pulls`, githubToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `${issue.identifier}: ${issue.title}`,
      head: branchName,
      base,
      body: `Automated PR generated from Linear issue [${issue.identifier}](${issue.url}).`,
    }),
  });

  console.log(`PR opened: ${pr.html_url}`);
  return pr;
}

async function main() {
  loadDotEnv();
  const { issueRef, base: baseOverride, repo: repoArg, team: teamArg, limit, poll } = parseArgs(process.argv);

  const linearApiKey = process.env.LINEAR_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN;
  const repoPath = repoArg || process.env.REPO_PATH;
  const teamKey = teamArg || process.env.LINEAR_TEAM_KEY || null;
  if (!linearApiKey) fail("LINEAR_API_KEY environment variable is not set");
  if (!githubToken) fail("GITHUB_TOKEN environment variable is not set");
  if (!repoPath) fail("target repo path not set; pass --repo <path> or set REPO_PATH");

  const remoteUrl = run("git", ["remote", "get-url", "origin"], repoPath);
  const { owner, repo } = parseOwnerRepo(remoteUrl);

  const repoInfo = await githubApi(`/repos/${owner}/${repo}`, githubToken);
  const base = baseOverride || repoInfo.default_branch;

  const status = run("git", ["status", "--porcelain"], repoPath);
  if (status) fail(`working tree at ${repoPath} has uncommitted changes; commit or stash them before running the agent`);

  ensureBaseBranch(repoPath, base);
  const ctx = { repoPath, owner, repo, base, githubToken };

  if (poll) {
    console.log(`Polling Linear for recent issues${teamKey ? ` (team ${teamKey})` : ""}...`);
    const issues = await fetchRecentLinearIssues(linearApiKey, { teamKey, limit });
    // Oldest first, so PRs land in the order the issues were created.
    issues.reverse();
    let processed = 0;
    for (const issue of issues) {
      try {
        const pr = await processIssue(issue, ctx);
        if (pr) processed++;
      } catch (err) {
        console.error(`hello-agent: failed to process ${issue.identifier}: ${err.stack ?? err}`);
      }
    }
    console.log(`Poll complete: ${processed} new PR(s) opened out of ${issues.length} issue(s) checked.`);
    return;
  }

  const issue = issueRef
    ? await (async () => {
        const identifier = extractIdentifier(issueRef);
        console.log(`Fetching Linear issue ${identifier}...`);
        return fetchLinearIssue(identifier, linearApiKey);
      })()
    : await (async () => {
        console.log(`No issue ref given -- fetching the most recently created Linear issue${teamKey ? ` (team ${teamKey})` : ""}...`);
        return fetchLatestLinearIssue(linearApiKey, { teamKey });
      })();
  console.log(`Using issue ${issue.identifier}: ${issue.title}`);

  await processIssue(issue, ctx);
}

main().catch((err) => fail(err.stack ?? String(err)));
