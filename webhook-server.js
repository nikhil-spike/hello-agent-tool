#!/usr/bin/env node
// HTTP server that receives Linear webhooks and opens a GitHub PR the moment a new
// issue is created -- no polling delay. Reuses the same Linear/git/GitHub logic as
// hello-agent.js (lib/original.js); this file only adds the webhook transport.
//
// Local/dev usage:
//   node webhook-server.js --repo <path> [--port 3000]
//   (then tunnel it, e.g. `ngrok http 3000`, and point a Linear webhook at
//    <tunnel-url>/webhooks/linear -- see README for the full walkthrough)
//
// Required env vars: LINEAR_API_KEY, GITHUB_TOKEN, LINEAR_WEBHOOK_SECRET
// Repo path via REPO_PATH env var or --repo flag. Port via PORT env var or --port.

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchLinearIssue,
  githubApi,
  ensureBaseBranch,
  processIssue,
  updateIssuePR,
  getRepoConfig,
} from "./lib/original.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const envPath = join(__dirname, ".env");
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
  console.error(`webhook-server: ${message}`);
  process.exit(1);
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd }).trim();
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { repo: null, port: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") opts.repo = args[++i];
    else if (args[i] === "--port") opts.port = Number(args[++i]);
  }
  return opts;
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const gotBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Webhook deliveries are processed one at a time -- ctx.repoPath is a single
// git working tree and can't handle concurrent checkouts.
let queue = Promise.resolve();
function enqueue(task) {
  queue = queue.then(task).catch((err) => console.error(`[webhook] ${err.stack ?? err}`));
  return queue;
}

async function handleIssueCreated(payload, ctx) {
  const status = run("git", ["status", "--porcelain"], ctx.repoPath);
  if (status) {
    console.error(`[webhook] skipping: working tree at ${ctx.repoPath} has uncommitted changes`);
    return;
  }

  const issue = await fetchLinearIssue(payload.data.id, ctx.linearApiKey);
  console.log(`[webhook] New issue ${issue.identifier}: "${issue.title}" -- opening PR...`);
  const result = await processIssue(issue, ctx);
  if (result.success) {
    console.log(`[webhook] PR opened for ${issue.identifier}: ${result.prUrl}`);
  } else {
    console.log(`[webhook] ${issue.identifier}: ${result.message}`);
  }
}

// Fields whose change actually affects generated PR content -- status, assignee,
// priority, labels etc. change the ticket in Linear but wouldn't change a single
// byte of the file we push, so re-triggering on those would just be noisy no-op commits.
const CONTENT_FIELDS = ["title", "description"];

async function handleIssueUpdated(payload, ctx) {
  const changedFields = Object.keys(payload.updatedFrom ?? {});
  const relevantFields = changedFields.filter((f) => CONTENT_FIELDS.includes(f));

  console.log(
    `[webhook] update event for issue ${payload.data?.id} -- fields changed: ` +
      `[${changedFields.join(", ") || "none reported"}] -- content-relevant: [${relevantFields.join(", ") || "none"}]`
  );

  if (relevantFields.length === 0) {
    console.log("[webhook] decision: skip -- no title/description change, PR content wouldn't differ");
    return;
  }

  const status = run("git", ["status", "--porcelain"], ctx.repoPath);
  if (status) {
    console.error(`[webhook] skipping: working tree at ${ctx.repoPath} has uncommitted changes`);
    return;
  }

  const issue = await fetchLinearIssue(payload.data.id, ctx.linearApiKey);
  console.log(`[webhook] decision: check for existing PR on ${issue.identifier} and sync it if found`);
  console.log(`[webhook] tool call: updateIssuePR(${issue.identifier})`);

  const result = await updateIssuePR(issue, ctx);
  if (!result.success) {
    console.log(`[webhook] tool result: ${issue.identifier}: ${result.message}`);
    return;
  }
  if (result.updated) {
    console.log(`[webhook] tool result: PR #${result.prNumber} updated for ${issue.identifier}: ${result.prUrl}`);
  } else {
    console.log(`[webhook] tool result: ${issue.identifier}: ${result.message}`);
  }
}

async function main() {
  loadDotEnv();
  const { repo: repoArg, port: portArg } = parseArgs(process.argv);

  const linearApiKey = process.env.LINEAR_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN;
  const webhookSecret = process.env.LINEAR_WEBHOOK_SECRET;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const repoPath = repoArg || process.env.REPO_PATH;
  const port = portArg || Number(process.env.PORT) || 3000;

  if (!linearApiKey) fail("LINEAR_API_KEY environment variable is not set");
  if (!githubToken) fail("GITHUB_TOKEN environment variable is not set");
  if (!webhookSecret) fail("LINEAR_WEBHOOK_SECRET environment variable is not set (create one when adding the webhook in Linear)");
  if (!repoPath) fail("target repo path not set; pass --repo <path> or set REPO_PATH");
  if (!geminiApiKey) console.warn("[webhook] GEMINI_API_KEY not set -- PRs will be created without an AI-generated implementation sketch");

  const { owner, repo } = getRepoConfig(repoPath);
  const repoInfo = await githubApi(`/repos/${owner}/${repo}`, githubToken);
  const base = repoInfo.default_branch;

  const status = run("git", ["status", "--porcelain"], repoPath);
  if (status) fail(`working tree at ${repoPath} has uncommitted changes; commit or stash them before starting the server`);

  ensureBaseBranch(repoPath, base);
  const ctx = { repoPath, owner, repo, base, githubToken, linearApiKey, geminiApiKey };

  const server = createServer(async (req, res) => {
    console.log(`[webhook] ${req.method} ${req.url}`);

    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok\n");
      return;
    }

    if (req.method !== "POST" || req.url !== "/webhooks/linear") {
      res.writeHead(404);
      res.end();
      return;
    }

    const rawBody = await readRawBody(req);
    const signature = req.headers["linear-signature"];
    if (!verifySignature(rawBody, signature, webhookSecret)) {
      console.warn("[webhook] rejected delivery: invalid or missing signature");
      res.writeHead(401);
      res.end("invalid signature");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.writeHead(400);
      res.end("invalid JSON");
      return;
    }

    // Ack immediately -- Linear expects a fast response, and PR creation
    // (git push + GitHub API call) can take a few seconds.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));

    if (payload.type === "Issue" && payload.action === "create") {
      enqueue(() => handleIssueCreated(payload, ctx));
      return;
    }

    if (payload.type === "Issue" && payload.action === "update") {
      enqueue(() => handleIssueUpdated(payload, ctx));
      return;
    }

    console.log(`[webhook] ignoring ${payload.type ?? "unknown"} ${payload.action ?? "unknown"} event`);
  });

  server.listen(port, () => {
    console.log(`Linear webhook server listening on http://localhost:${port}`);
    console.log(`Target repo: ${owner}/${repo} (base: ${base})`);
    console.log(`Point Linear's webhook at <your-tunnel-url>/webhooks/linear`);
  });
}

main().catch((err) => fail(err.stack ?? String(err)));
