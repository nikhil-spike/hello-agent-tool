import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd }).trim();
}

export function parseOwnerRepo(remoteUrl) {
  const sshMatch = remoteUrl.match(/^git@[^:]+:([^/]+)\/(.+?)(\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  const httpsMatch = remoteUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  throw new Error(`could not parse owner/repo from remote URL "${remoteUrl}"`);
}

export async function linearGraphQL(apiKey, query, variables) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Linear API error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data;
}

export async function fetchLinearIssue(identifier, apiKey) {
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
  if (!data?.issue) throw new Error(`Linear issue "${identifier}" not found`);
  return data.issue;
}

export async function fetchRecentLinearIssues(apiKey, { teamKey, limit }) {
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

export async function fetchLatestLinearIssue(apiKey, { teamKey }) {
  const issues = await fetchRecentLinearIssues(apiKey, { teamKey, limit: 1 });
  if (!issues[0]) throw new Error(teamKey ? `no Linear issues found for team "${teamKey}"` : "no Linear issues found for this API key");
  return issues[0];
}

export async function githubApi(path, token, options = {}) {
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
    throw new Error(`GitHub API ${options.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText}\n${body}`);
  }
  return res.json();
}

export async function prAlreadyExists(owner, repo, branchName, token) {
  const prs = await githubApi(`/repos/${owner}/${repo}/pulls?state=all&head=${owner}:${branchName}`, token);
  return prs.length > 0;
}

export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function buildMarkdown(issue) {
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

export function ensureBaseBranch(repoPath, base) {
  const remoteHeads = run("git", ["ls-remote", "--heads", "origin", base], repoPath);
  if (!remoteHeads) {
    console.log(`Base branch "${base}" doesn't exist on origin yet -- bootstrapping it with an empty initial commit...`);
    run("git", ["checkout", "--orphan", base], repoPath);
    run("git", ["commit", "--allow-empty", "-m", "Initial commit"], repoPath);
    run("git", ["push", "origin", base], repoPath);
  }
  run("git", ["fetch", "origin", base], repoPath);
}

export async function processIssue(issue, { repoPath, owner, repo, base, githubToken }) {
  const branchName = `hello-agent/${issue.identifier.toLowerCase()}`;

  if (await prAlreadyExists(owner, repo, branchName, githubToken)) {
    return { success: false, message: `PR already exists for branch ${branchName}` };
  }

  run("git", ["checkout", "-B", base, `origin/${base}`], repoPath);
  run("git", ["checkout", "-B", branchName], repoPath);

  const slug = slugify(issue.title);
  const relativeFilePath = join("tickets", `${issue.identifier.toLowerCase()}-${slug}.md`);
  const absoluteFilePath = join(repoPath, relativeFilePath);
  mkdirSync(dirname(absoluteFilePath), { recursive: true });
  writeFileSync(absoluteFilePath, buildMarkdown(issue));

  run("git", ["add", relativeFilePath], repoPath);
  run("git", ["commit", "-m", `Add ${issue.identifier}: ${issue.title}`], repoPath);
  run("git", ["push", "-u", "origin", branchName, "--force-with-lease"], repoPath);

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

  return { success: true, prUrl: pr.html_url, prNumber: pr.number };
}

export function getRepoConfig(repoPath) {
  const remoteUrl = run("git", ["remote", "get-url", "origin"], repoPath);
  const { owner, repo } = parseOwnerRepo(remoteUrl);
  return { owner, repo, remoteUrl };
}
