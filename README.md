# hello-agent

An event-driven agent that turns a Linear issue into a GitHub pull request. Linear calls
`webhook-server.js` the instant a new issue is created (or an existing one is updated); it opens
(or updates) the PR within seconds, no polling delay.

Writes to and opens PRs against a single hardcoded target repo: **`nikhil-spike/spike-agent`**.
This tool's own code is never committed there — only the generated `tickets/*.md` files are.

## Requirements

- Node.js >= 18 (uses global `fetch`)
- A local clone of the target repo, with `origin` set up and push access already working
  (i.e. `git push` succeeds from that clone without extra flags)
- A Linear API key with read access to the relevant team(s)
- A GitHub token (PAT or similar) with `repo` scope on the target repo, scoped to
  `nikhil-spike/spike-agent`
- A free Gemini API key (optional — used for an AI-generated implementation sketch on each PR;
  without it, PRs are still opened, just without the sketch) — get one at
  [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)

## Setup

Copy `.env.example` to `.env` and fill in the values:

```
LINEAR_API_KEY=lin_api_...
GITHUB_TOKEN=ghp_...
GEMINI_API_KEY=your_gemini_api_key_here
REPO_PATH=/path/to/local/clone/of/spike-agent
# GEMINI_MODEL=gemini-2.5-flash-lite   # optional override; this is already the default
LINEAR_WEBHOOK_SECRET=lin_wh_...
# PORT=3000
```

## Usage

```
node webhook-server.js --repo /path/to/spike-agent
# or: npm run webhook
```

It needs `LINEAR_API_KEY`/`GITHUB_TOKEN`/`REPO_PATH` (env var or `--repo` flag), plus
`LINEAR_WEBHOOK_SECRET` (Linear gives you this when you create the webhook — see step 2 below).
`GEMINI_API_KEY` is optional; without it, PRs open without an AI-generated implementation sketch.

**To test it end-to-end:**

1. Start the server: `node webhook-server.js --repo /path/to/spike-agent`. It listens on
   `http://localhost:3000` by default (`--port` or `PORT` to change it).
2. Expose it publicly with a tunnel, e.g. `ngrok http 3000`. Copy the `https://...ngrok...`
   URL it gives you.
3. In Linear: **Settings → API → Webhooks → New webhook**. Set the URL to
   `<ngrok-url>/webhooks/linear`, enable the **Issues** resource, and copy the signing secret
   Linear generates into `LINEAR_WEBHOOK_SECRET` in your `.env` (restart the server after
   adding it).
4. Create a new issue in Linear (any team the API key can read). Within a couple seconds you
   should see `[webhook] New issue LIN-xx: "..." -- opening PR...` in the server's terminal,
   followed by a link to the opened PR.
5. Check the PR itself on GitHub, and check the ngrok inspector (`http://127.0.0.1:4040`) or
   Linear's webhook delivery log (same settings page) if a delivery doesn't show up.

`Issue` `create` events open a new PR; `update` events on an issue that already has an open PR
regenerate the ticket file and push it to the existing branch. The server rejects any request
whose `Linear-Signature` header doesn't match an HMAC-SHA256 of the raw body computed with your
webhook secret, and serializes deliveries so concurrent webhooks can't race on the same git
working tree.

This is local/dev-only for now — nothing here is deployed anywhere. Once you're happy with the
behavior, hosting it somewhere with a stable public URL (so you don't need ngrok, and Linear
delivers straight to it) is a separate follow-up.

## Repository structure

```
hello-agent-tool/
├── webhook-server.js   Event-driven entry point: Linear webhook -> PR
├── lib/
│   ├── llm.js          Thin wrapper around the Gemini generateContent REST API,
│   │                    used for the issue-triage tool call (implementation sketch)
│   └── original.js     Linear/GitHub/git logic used by webhook-server.js
├── .env.example         Template for required environment variables
├── package.json
└── README.md
```

### What each file does

- **`webhook-server.js`** — Plain `node:http` server, no framework. Verifies each request's
  `Linear-Signature` against `LINEAR_WEBHOOK_SECRET` (HMAC-SHA256 of the raw body), acks
  immediately, then — for `Issue` `create`/`update` events — re-fetches the issue via
  `fetchLinearIssue()` and calls `processIssue()`/`updateIssuePR()`, both from `lib/original.js`.
  Deliveries are serialized through an in-process queue since git operations can't run
  concurrently against a single working tree.

- **`lib/original.js`** — Linear GraphQL calls (`fetchLinearIssue`, `fetchRecentLinearIssues`,
  `fetchLatestLinearIssue`), GitHub REST calls (`githubApi`, `prAlreadyExists`), git plumbing
  (`ensureBaseBranch`, `processIssue`, `updateIssuePR`), and markdown generation
  (`buildMarkdown`). Also runs the Gemini triage step (`runTriageAgent`) before writing each
  ticket file, folding an AI-generated implementation sketch into the PR when a `GEMINI_API_KEY`
  is configured.

- **`lib/llm.js`** — `triageIssue()`, used by `lib/original.js` to decide whether an incoming
  issue looks like a coding task worth an implementation sketch in the PR. Default model:
  `gemini-2.5-flash-lite` (highest free-tier quota — 15 requests/min, 1,000 requests/day),
  overridable via `GEMINI_MODEL`.

## Notes / gotchas

- The server refuses to start if the target repo's working tree has uncommitted changes.
- `hello-agent/<identifier>` branches are reused — if a PR already exists for that branch, a new
  `create` event for the same issue is skipped rather than duplicated.
- A triage failure (quota hit, API hiccup) never blocks PR creation — it just falls back to a
  plain file with no implementation sketch.
- The Gemini free tier resets daily at midnight Pacific time and is disabled the moment billing
  is enabled on the project.
