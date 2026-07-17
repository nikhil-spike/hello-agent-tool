# hello-agent

Minimal agent: reads a Linear issue (a specific one, or the latest one created), writes its
details to a markdown file inside a target repo, and opens a GitHub PR with that change.

This tool's own code is **never committed to the target repo** — it runs from wherever you
keep it and operates on a separate local clone of the target repo, pointed to via `--repo`.

## Requirements

- Node.js >= 18 (uses global `fetch`)
- A local clone of the target repo, with `origin` set up and push access already working
  (i.e. `git push` succeeds from that clone without extra flags)
- A Linear API key with read access to the relevant team(s)
- A GitHub token (PAT or similar) with `repo` scope on the target repo

## Setup

```
export LINEAR_API_KEY=lin_api_...
export GITHUB_TOKEN=ghp_...
export REPO_PATH=/path/to/local/clone/of/target-repo   # or pass --repo each time
```

(On Windows PowerShell: `$env:LINEAR_API_KEY = "lin_api_..."`, etc.)

## Usage

```
# Auto-fetch the most recently created Linear issue
node hello-agent.js --repo /path/to/target-repo

# Use a specific issue
node hello-agent.js --repo /path/to/target-repo LIN-123
node hello-agent.js --repo /path/to/target-repo https://linear.app/yourteam/issue/LIN-123/some-slug

# Override the PR base branch (defaults to the repo's default branch)
node hello-agent.js --repo /path/to/target-repo LIN-123 --base develop
```

## What it does

1. Fetches the issue (identifier, title, description, URL) from Linear's GraphQL API —
   either the one you specify, or the most recently created issue if you pass none.
2. In the target repo clone: creates a branch `hello-agent/<identifier>` off the base branch.
   (If the base branch doesn't exist yet on origin — e.g. a brand-new empty repo — it's
   bootstrapped with an empty initial commit first.)
3. Writes `tickets/<identifier>-<slug>.md` containing the issue id, title, description, and
   a trailing `Hello world from agent` line.
4. Commits, pushes the branch, and opens a PR against the base branch via the GitHub REST API.

## Notes

- Requires a clean working tree in the target repo before running (uncommitted changes abort the run).
- Repo owner/repo are derived from the target clone's `git remote get-url origin`, so this
  works with any SSH host alias (e.g. custom `Host` entries in `~/.ssh/config`) or HTTPS
  remote — no repo-specific config baked into the script.
