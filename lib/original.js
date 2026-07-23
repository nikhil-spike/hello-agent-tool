import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { triageIssue } from "./llm.js";

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

export async function getOpenPullRequest(owner, repo, branchName, token) {
  const prs = await githubApi(`/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${branchName}`, token);
  return prs[0] ?? null;
}

export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function buildMarkdown(issue, agentResult) {
  const description = issue.description?.trim() || "_No description provided._";
  let agentSection = "";
  if (agentResult?.kind === "pseudocode") {
    agentSection = `\n## Implementation sketch (AI-generated)\n\n\`\`\`\n${agentResult.content}\n\`\`\`\n`;
  } else if (agentResult?.kind === "greeting") {
    agentSection = `\n## Agent note\n\n\`\`\`\n${agentResult.content}\n\`\`\`\n`;
  }
  return `# ${issue.identifier}: ${issue.title}

**Linear issue:** ${issue.url}
**Issue ID:** ${issue.identifier}

## Description

${description}
${agentSection}`;
}

// Executes whichever tool the triage call picked. write_greeting's timestamp is
// generated here, not by the model -- an LLM has no reliable notion of "now".
function executeAgentTool(toolCall) {
  if (toolCall.name === "write_pseudocode") {
    return { kind: "pseudocode", content: (toolCall.args?.sketch || "").trim() };
  }
  if (toolCall.name === "write_greeting") {
    return { kind: "greeting", content: `Hello from Nikhil's Agent\n${new Date().toString()}` };
  }
  throw new Error(`unknown tool call from triage: ${toolCall.name}`);
}

// Asks Gemini to classify the issue and pick a tool, then runs it, logging the
// decision and tool call/result. Never throws -- a quota hit or API hiccup
// shouldn't block PR creation, it should just fall back to a plain file.
async function runTriageAgent(issue, geminiApiKey) {
  if (!geminiApiKey) {
    console.log(`[agent] no GEMINI_API_KEY configured -- skipping triage for ${issue.identifier}`);
    return null;
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  console.log(`[agent] LLM call: triageIssue(${issue.identifier}) via ${model}`);
  try {
    const toolCall = await triageIssue(geminiApiKey, issue);
    console.log(`[agent] LLM decision for ${issue.identifier}: call tool "${toolCall.name}" args=${JSON.stringify(toolCall.args)}`);
    const result = executeAgentTool(toolCall);
    console.log(`[agent] tool "${toolCall.name}" executed for ${issue.identifier} -- output:\n${result.content}`);
    return result;
  } catch (err) {
    console.error(`[agent] triage failed for ${issue.identifier}: ${err.message} -- falling back to description-only file`);
    return null;
  }
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

export async function processIssue(issue, { repoPath, owner, repo, base, githubToken, geminiApiKey }) {
  const branchName = `hello-agent/${issue.identifier.toLowerCase()}`;

  if (await prAlreadyExists(owner, repo, branchName, githubToken)) {
    return { success: false, message: `PR already exists for branch ${branchName}` };
  }

  run("git", ["checkout", "-B", base, `origin/${base}`], repoPath);
  run("git", ["checkout", "-B", branchName], repoPath);

  const agentResult = await runTriageAgent(issue, geminiApiKey);

  const slug = slugify(issue.title);
  const relativeFilePath = join("tickets", `${issue.identifier.toLowerCase()}-${slug}.md`);
  const absoluteFilePath = join(repoPath, relativeFilePath);
  mkdirSync(dirname(absoluteFilePath), { recursive: true });
  writeFileSync(absoluteFilePath, buildMarkdown(issue, agentResult));

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

// Called when a Linear issue that already has an open PR (branch hello-agent/<id>)
// changes. Regenerates the ticket file from the current issue state, pushes it to
// the existing branch, and updates the PR title/body -- no new PR is opened.
export async function updateIssuePR(issue, { repoPath, owner, repo, githubToken, geminiApiKey }) {
  const branchName = `hello-agent/${issue.identifier.toLowerCase()}`;

  const pr = await getOpenPullRequest(owner, repo, branchName, githubToken);
  if (!pr) {
    return { success: false, message: `No open PR found for branch ${branchName}; nothing to update` };
  }

  run("git", ["fetch", "origin", branchName], repoPath);
  run("git", ["checkout", "-B", branchName, `origin/${branchName}`], repoPath);

  const agentResult = await runTriageAgent(issue, geminiApiKey);

  const ticketsDir = join(repoPath, "tickets");
  const idPrefix = `${issue.identifier.toLowerCase()}-`;
  const slug = slugify(issue.title);
  const relativeFilePath = join("tickets", `${issue.identifier.toLowerCase()}-${slug}.md`);
  const absoluteFilePath = join(repoPath, relativeFilePath);

  // Title changes shift the slug, which shifts the filename -- remove any stale
  // file(s) for this issue before writing the new one so renames don't leave orphans.
  if (existsSync(ticketsDir)) {
    for (const entry of readdirSync(ticketsDir)) {
      if (entry.startsWith(idPrefix) && entry !== `${issue.identifier.toLowerCase()}-${slug}.md`) {
        run("git", ["rm", "-q", join("tickets", entry)], repoPath);
      }
    }
  }

  mkdirSync(dirname(absoluteFilePath), { recursive: true });
  writeFileSync(absoluteFilePath, buildMarkdown(issue, agentResult));
  run("git", ["add", relativeFilePath], repoPath);

  const status = run("git", ["status", "--porcelain"], repoPath);
  if (!status) {
    return {
      success: true,
      updated: false,
      message: `No content changes for ${issue.identifier}; PR #${pr.number} already up to date`,
      prUrl: pr.html_url,
      prNumber: pr.number,
    };
  }

  run("git", ["commit", "-m", `Update ${issue.identifier}: ${issue.title}`], repoPath);
  run("git", ["push", "origin", branchName, "--force-with-lease"], repoPath);

  const updatedPr = await githubApi(`/repos/${owner}/${repo}/pulls/${pr.number}`, githubToken, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `${issue.identifier}: ${issue.title}`,
      body: `Automated PR generated from Linear issue [${issue.identifier}](${issue.url}).\n\n_Updated to reflect the latest changes in Linear._`,
    }),
  });

  return { success: true, updated: true, prUrl: updatedPr.html_url, prNumber: updatedPr.number };
}

export function getRepoConfig(repoPath) {
  const remoteUrl = run("git", ["remote", "get-url", "origin"], repoPath);
  const { owner, repo } = parseOwnerRepo(remoteUrl);
  return { owner, repo, remoteUrl };
}
