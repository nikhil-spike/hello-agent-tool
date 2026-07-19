import {
  fetchLinearIssue,
  fetchLatestLinearIssue,
  fetchRecentLinearIssues,
  processIssue,
  getRepoConfig,
  githubApi,
} from "./original.js";

export const tools = [
  {
    name: "fetch_linear_issue",
    description: "Fetch a specific Linear issue by its identifier (e.g., LIN-123) or URL. Returns issue details including title, description, and URL.",
    parameters: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "The Linear issue identifier (e.g., LIN-123) or full Linear URL",
        },
      },
      required: ["identifier"],
    },
  },
  {
    name: "fetch_latest_issue",
    description: "Fetch the most recently created Linear issue. Optional team filter.",
    parameters: {
      type: "object",
      properties: {
        teamKey: {
          type: "string",
          description: "Optional team key to filter by (e.g., ENG, PROD)",
        },
      },
    },
  },
  {
    name: "list_recent_issues",
    description: "List recent Linear issues. Returns a list of issues with their identifiers and titles.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of issues to return (default: 10)",
        },
        teamKey: {
          type: "string",
          description: "Optional team key to filter by",
        },
      },
    },
  },
  {
    name: "create_pull_request",
    description: "Create a GitHub PR for a Linear issue in the configured target repository (nikhil-spike/spike-agent). Writes issue details to a markdown file and opens a PR.",
    parameters: {
      type: "object",
      properties: {
        issueIdentifier: {
          type: "string",
          description: "The Linear issue identifier (e.g., LIN-123)",
        },
        baseBranch: {
          type: "string",
          description: "Base branch for the PR (optional, uses repo default)",
        },
      },
      required: ["issueIdentifier"],
    },
  },
  {
    name: "get_repository_info",
    description: "Get information about the configured target repository (owner, repo name, default branch).",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];

// This tool's GitHub PAT is fine-grained and scoped to a single repository, so
// PR creation must always target it regardless of what a caller passes in --
// pointing elsewhere would just fail auth (or worse, silently target the wrong repo
// if the token were ever broadened).
const ALLOWED_OWNER = "nikhil-spike";
const ALLOWED_REPO = "spike-agent";

function allowedRepoError(owner, repo) {
  if (owner.toLowerCase() === ALLOWED_OWNER && repo.toLowerCase() === ALLOWED_REPO) {
    return null;
  }
  return (
    `REPO_PATH resolves to ${owner}/${repo}, but this agent's GitHub PAT is only ` +
    `authorized for ${ALLOWED_OWNER}/${ALLOWED_REPO}. Point REPO_PATH at a local ` +
    `clone of https://github.com/${ALLOWED_OWNER}/${ALLOWED_REPO}.`
  );
}

export async function executeTool(toolName, args, env) {
  const { LINEAR_API_KEY, GITHUB_TOKEN, REPO_PATH } = env;

  switch (toolName) {
    case "fetch_linear_issue": {
      const identifier = args.identifier.toUpperCase();
      const issue = await fetchLinearIssue(identifier, LINEAR_API_KEY);
      return { success: true, issue };
    }

    case "fetch_latest_issue": {
      const issue = await fetchLatestLinearIssue(LINEAR_API_KEY, { teamKey: args.teamKey });
      return { success: true, issue };
    }

    case "list_recent_issues": {
      const issues = await fetchRecentLinearIssues(LINEAR_API_KEY, {
        teamKey: args.teamKey,
        limit: args.limit || 10,
      });
      return { success: true, issues };
    }

    case "create_pull_request": {
      const repoPath = REPO_PATH;
      if (!repoPath) {
        return { success: false, error: "No repository path configured (set REPO_PATH)" };
      }

      const { owner, repo } = getRepoConfig(repoPath);
      const repoError = allowedRepoError(owner, repo);
      if (repoError) {
        return { success: false, error: repoError };
      }
      const repoInfo = await githubApi(`/repos/${owner}/${repo}`, GITHUB_TOKEN);
      const base = args.baseBranch || repoInfo.default_branch;

      const issue = await fetchLinearIssue(args.issueIdentifier.toUpperCase(), LINEAR_API_KEY);
      const result = await processIssue(issue, {
        repoPath,
        owner,
        repo,
        base,
        githubToken: GITHUB_TOKEN,
      });

      return result;
    }

    case "get_repository_info": {
      const repoPath = REPO_PATH;
      if (!repoPath) {
        return { success: false, error: "No repository path configured (set REPO_PATH)" };
      }
      const { owner, repo, remoteUrl } = getRepoConfig(repoPath);
      const repoError = allowedRepoError(owner, repo);
      if (repoError) {
        return { success: false, error: repoError };
      }
      return { success: true, owner, repo, remoteUrl };
    }

    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}
