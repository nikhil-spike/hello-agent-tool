# hello-agent

Two ways to turn a Linear issue into a GitHub pull request:

1. **`hello-agent.js`** — a deterministic CLI script. Point it at an issue (or let it grab the
   latest one), and it writes a ticket file, commits, pushes a branch, and opens a PR. No LLM
   involved. This is also what runs on a schedule via GitHub Actions.
2. **`agent.js`** — a conversational agent. You chat with it in plain English ("what's the
   latest issue?", "open a PR for LIN-42"); it uses **Gemini** (function calling) to decide
   which tool to call, asks you for confirmation according to your chosen autonomy level, and
   reports back.

Both paths write to and open PRs against a single hardcoded target repo:
**`nikhil-spike/spike-agent`**. This tool's own code is never committed there — only the
generated `tickets/*.md` files are.

## Requirements

- Node.js >= 18 (uses global `fetch`)
- A local clone of the target repo, with `origin` set up and push access already working
  (i.e. `git push` succeeds from that clone without extra flags)
- A Linear API key with read access to the relevant team(s)
- A GitHub token (PAT or similar) with `repo` scope on the target repo, scoped to
  `nikhil-spike/spike-agent`
- A free Gemini API key (only needed for `agent.js`) — get one at
  [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)

## Setup

Copy `.env.example` to `.env` and fill in the values:

```
LINEAR_API_KEY=lin_api_...
GITHUB_TOKEN=ghp_...
GEMINI_API_KEY=your_gemini_api_key_here
REPO_PATH=/path/to/local/clone/of/spike-agent
# GEMINI_MODEL=gemini-2.5-flash-lite   # optional override; this is already the default
```

Both entry points auto-load `.env` from the project root (no `dotenv` dependency needed) and
also accept the same values as real environment variables / `--repo` flags.

## Usage

### Scripted mode — `hello-agent.js`

```
# Auto-fetch the most recently created Linear issue
node hello-agent.js --repo /path/to/spike-agent

# Use a specific issue, by identifier or Linear URL
node hello-agent.js --repo /path/to/spike-agent LIN-123
node hello-agent.js --repo /path/to/spike-agent https://linear.app/yourteam/issue/LIN-123/some-slug

# Override the PR base branch (defaults to the repo's default branch)
node hello-agent.js --repo /path/to/spike-agent LIN-123 --base develop

# Poll mode: process every recent issue that doesn't have a PR yet
node hello-agent.js --poll --repo /path/to/spike-agent --limit 20 --team ENG
```

Runs the same way via `npm start`, or as the `hello-agent` bin if installed globally/linked.

### Conversational mode — `agent.js`

```
npm run agent
# or: node agent.js
```

On startup it asks how autonomous it should be for this run:

| Choice | Behavior |
|---|---|
| `1` — confirm always | Asks before every single tool call |
| `2` — confirm once | Asks the first time it sees a given tool+args combo, remembers it for the rest of the run |
| `3` — auto-execute | Runs tools immediately, no prompts |

Your choice (and any per-action confirmations under mode 2) is persisted to
`.agent-config.json` and offered back as the default next time you run it.

Then just type requests in plain English, e.g.:

```
You: what's the latest issue in Linear?
You: open a PR for LIN-42
You: list the last 5 issues for the ENG team
exit
```

### Scheduled automation — GitHub Actions

`.github/workflows/poll.yml` runs `hello-agent.js --poll` every 5 minutes (and on manual
dispatch). It checks out this repo, clones the target repo using a PAT stored in
`secrets.TARGET_REPO_PAT`, and opens PRs for any Linear issues that don't have one yet.

## Repository structure

```
hello-agent-tool/
├── agent.js                    Conversational entry point (chat + Gemini tool-calling loop)
├── hello-agent.js               Scripted entry point (single-issue / --poll, no LLM)
├── lib/
│   ├── llm.js                   Thin wrapper around the Gemini generateContent REST API
│   ├── tools.js                 Tool schemas + executor exposed to the LLM; enforces the
│   │                             hardcoded target repo (nikhil-spike/spike-agent)
│   ├── original.js              Shared Linear/GitHub/git logic (fetch issue, build markdown,
│   │                             commit+push+open PR) — imported by tools.js
│   └── config.js                Autonomy-level prompts + .agent-config.json persistence
├── .github/workflows/poll.yml   Scheduled CI job: runs hello-agent.js --poll every 5 min
├── .agent-config.json           Persisted autonomy choice + confirmed actions (agent.js only)
├── .env.example                 Template for required environment variables
├── package.json                 Two bins: `hello-agent` → hello-agent.js, `agent` → agent.js
└── README.md
```

### What each file does, and how they relate

- **`agent.js`** — REPL loop. Loads `.env`, reads `GEMINI_API_KEY`/`GEMINI_MODEL`, asks
  `lib/config.js` for the autonomy level, then for each user message calls
  `GeminiLLM.chat()` (from `lib/llm.js`) with the tool schemas from `lib/tools.js`. If Gemini
  responds with a function call, it checks `shouldExecute()` (autonomy gate), runs
  `executeTool()`, formats the result for display, and feeds the result back to Gemini for a
  natural-language follow-up.

- **`hello-agent.js`** — Self-contained CLI script. Duplicates the same
  Linear-fetch/git/GitHub-PR logic found in `lib/original.js` (kept inline here so this file
  has zero dependency on `lib/`, matching its header comment that "this tool's own code is
  never committed to the target repo"). Parses `--repo`/`--base`/`--team`/`--limit`/`--poll`
  flags, resolves the issue(s), and calls `processIssue()` to do the git/GitHub work.

- **`lib/original.js`** — The reusable core: Linear GraphQL calls (`fetchLinearIssue`,
  `fetchRecentLinearIssues`, `fetchLatestLinearIssue`), GitHub REST calls (`githubApi`,
  `prAlreadyExists`), git plumbing (`ensureBaseBranch`, `processIssue`), and markdown
  generation (`buildMarkdown`). This is effectively the same logic as `hello-agent.js`'s
  inline functions, factored out so `lib/tools.js` (and therefore `agent.js`) can reuse it
  without re-implementing it.

- **`lib/tools.js`** — Declares the 5 function-calling schemas Gemini is told about
  (`fetch_linear_issue`, `fetch_latest_issue`, `list_recent_issues`, `create_pull_request`,
  `get_repository_info`), and `executeTool()`, which dispatches a named call to the
  corresponding `lib/original.js` function. Hardcodes `ALLOWED_OWNER`/`ALLOWED_REPO` as a
  safety check — even if Gemini or `REPO_PATH` point somewhere else, PR creation refuses to
  target any repo other than `nikhil-spike/spike-agent`, since the GitHub PAT is scoped to it.

- **`lib/llm.js`** — `GeminiLLM` class. Wraps `POST
  .../v1beta/models/{model}:generateContent`, keeps conversation history, injects the system
  prompt (defines the agent's persona and refusal behavior for out-of-scope requests), and
  parses back `{ text, functionCalls }`. Default model: `gemini-2.5-flash-lite` (highest
  free-tier quota — 15 requests/min, 1,000 requests/day), overridable via `GEMINI_MODEL`.

- **`lib/config.js`** — Everything about autonomy: prompts the user for a level at startup
  (`promptForAutonomyLevel`), persists it plus any per-action confirmations to
  `.agent-config.json` (`loadConfig`/`saveConfig`), and gates each tool call
  (`shouldExecute`) based on the chosen level.

- **`.github/workflows/poll.yml`** — Cron-triggered (`*/5 * * * *`) CI job. Clones the
  target repo fresh each run using `secrets.TARGET_REPO_PAT`, then runs
  `node hello-agent.js --poll` against that clone — the same code path as running it
  locally, just unattended.

- **`.agent-config.json`** — Runtime state for `agent.js` only; not read by
  `hello-agent.js`. Reset (`confirmedActions` cleared) at the start of every `agent.js` run.

## Architecture / dependency tree

```
                          ┌───────────────────┐
                          │    package.json    │
                          │  bins: hello-agent, │
                          │        agent        │
                          └─────────┬─────────┘
                    ┌───────────────┴───────────────┐
                    │                                 │
                    ▼                                 ▼
        ┌──────────────────────┐          ┌──────────────────────┐
        │    hello-agent.js     │          │       agent.js        │
        │  (scripted, no LLM)   │          │  (chat + Gemini LLM)  │
        │  inline Linear/Git/   │          │                        │
        │  GitHub logic         │          └──────────┬─────────────┘
        └──────────┬────────────┘                     │
                    │                    ┌─────────────┼─────────────────┐
                    │                    ▼             ▼                 ▼
                    │            lib/llm.js     lib/tools.js      lib/config.js
                    │           (Gemini REST)   (tool schemas +   (autonomy prompts,
                    │                             executeTool)     .agent-config.json)
                    │                                  │
                    │                                  ▼
                    │                          lib/original.js
                    │                     (Linear GraphQL, GitHub REST,
                    │                      git plumbing, markdown build)
                    │                                  │
                    └──────────────┬───────────────────┘
                                   ▼
                  ┌──────────────────────────────────┐
                  │  External services touched by      │
                  │  both entry points:                 │
                  │   • Linear GraphQL API              │
                  │   • GitHub REST API                 │
                  │   • local `git` (via child_process) │
                  │   • target repo: nikhil-spike/       │
                  │     spike-agent (hardcoded)          │
                  └──────────────────────────────────┘

.github/workflows/poll.yml ──cron──▶ node hello-agent.js --poll ──▶ (same path as above)
```

## Example interaction — conversational mode

This is what happens end-to-end when you run `node agent.js` and ask it to open a PR for a
specific issue:

```
┌──────┐        ┌──────────┐        ┌───────────┐        ┌────────────┐        ┌────────┐        ┌────────┐
│ User │        │ agent.js │        │ lib/llm.js │        │ lib/tools.js│       │lib/orig│        │ Linear/│
│      │        │ (REPL)   │        │ (Gemini)   │        │ + executeTool│      │inal.js │        │ GitHub │
└──┬───┘        └────┬─────┘        └─────┬─────┘        └──────┬──────┘       └───┬────┘        └───┬────┘
   │  "open a PR       │                    │                     │                  │                 │
   │  for LIN-42"       │                    │                     │                  │                 │
   │──────────────────▶│                    │                     │                  │                 │
   │                   │  chat(msg, tools)   │                     │                  │                 │
   │                   │───────────────────▶│                     │                  │                 │
   │                   │                    │ POST generateContent │                  │                 │
   │                   │                    │ (Gemini decides:     │                  │                 │
   │                   │                    │  call create_pull_    │                  │                 │
   │                   │                    │  request, args:       │                  │                 │
   │                   │                    │  {issueIdentifier:    │                  │                 │
   │                   │                    │   "LIN-42"})          │                  │                 │
   │                   │◀───────────────────│                     │                  │                 │
   │                   │  functionCalls: [create_pull_request]     │                  │                 │
   │                   │                    │                     │                  │                 │
   │                   │  shouldExecute()   │                     │                  │                 │
   │                   │  (autonomy gate —  │                     │                  │                 │
   │                   │   may prompt user) │                     │                  │                 │
   │  "Execute...? y/n"│                    │                     │                  │                 │
   │◀──────────────────│                    │                     │                  │                 │
   │  "y"              │                    │                     │                  │                 │
   │──────────────────▶│                    │                     │                  │                 │
   │                   │  executeTool("create_pull_request", args) │                  │                 │
   │                   │────────────────────┼────────────────────▶│                  │                 │
   │                   │                    │                     │ check ALLOWED_   │                 │
   │                   │                    │                     │ OWNER/REPO       │                 │
   │                   │                    │                     │ fetchLinearIssue()│                 │
   │                   │                    │                     │─────────────────▶│  GraphQL query   │
   │                   │                    │                     │                  │────────────────▶│
   │                   │                    │                     │                  │◀────────────────│
   │                   │                    │                     │◀─────────────────│  issue details   │
   │                   │                    │                     │ processIssue():  │                 │
   │                   │                    │                     │  git checkout -B │                 │
   │                   │                    │                     │  branch          │                 │
   │                   │                    │                     │  write tickets/  │                 │
   │                   │                    │                     │  LIN-42-*.md     │                 │
   │                   │                    │                     │  git commit+push │                 │
   │                   │                    │                     │─────────────────▶│  POST /pulls     │
   │                   │                    │                     │                  │────────────────▶│
   │                   │                    │                     │                  │◀────────────────│
   │                   │                    │                     │◀─────────────────│  PR created      │
   │                   │◀───────────────────┼─────────────────────│ {success, prUrl, │                 │
   │                   │  result: {prUrl,…} │                     │  prNumber}       │                 │
   │                   │  formatToolResult()│                     │                  │                 │
   │  "PR #7 created!   │                    │                     │                  │                 │
   │   View it here:…"  │                    │                     │                  │                 │
   │◀──────────────────│                    │                     │                  │                 │
   │                   │  chat("Tool …      │                     │                  │                 │
   │                   │   returned: …")     │                     │                  │                 │
   │                   │───────────────────▶│ (follow-up summary) │                  │                 │
   │                   │◀───────────────────│                     │                  │                 │
   │  natural-language  │                    │                     │                  │                 │
   │  summary from Gemini│                   │                     │                  │                 │
   │◀──────────────────│                    │                     │                  │                 │
```

## Example interaction — scripted mode

```
$ node hello-agent.js --repo ~/code/spike-agent LIN-42

Fetching Linear issue LIN-42...
Using issue LIN-42: Fix flaky login test
Opening pull request for LIN-42...
PR opened: https://github.com/nikhil-spike/spike-agent/pull/7
```

Internally: `hello-agent.js` → Linear GraphQL (`fetchLinearIssue`) → local `git checkout -B
hello-agent/lin-42` → write `tickets/lin-42-fix-flaky-login-test.md` → `git commit` + `git push
--force-with-lease` → GitHub REST `POST /repos/nikhil-spike/spike-agent/pulls`.

## Notes / gotchas

- Both entry points refuse to run if the target repo's working tree has uncommitted changes.
- `hello-agent/<identifier>` branches are reused — if a PR already exists for that branch,
  the run (or that issue, in `--poll` mode) is skipped rather than duplicated.
- `lib/tools.js` hardcodes the allowed target repo (`nikhil-spike/spike-agent`) independently
  of `REPO_PATH`, so pointing `agent.js` at a different clone will fail fast with a clear
  error rather than silently opening a PR somewhere unexpected.
- The Gemini free tier resets daily at midnight Pacific time and is disabled the moment
  billing is enabled on the project — see `lib/llm.js` for the current default model.
