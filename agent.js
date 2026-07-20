#!/usr/bin/env node
import * as readline from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GeminiLLM } from "./lib/llm.js";
import { tools, executeTool } from "./lib/tools.js";
import {
  loadConfig,
  saveConfig,
  promptForAutonomyLevel,
  shouldExecute,
} from "./lib/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function formatToolResult(toolName, result) {
  if (result.success === false) {
    return `Failed: ${result.error || result.message || "Unknown error"}`;
  }

  switch (toolName) {
    case "fetch_linear_issue":
      if (result.issue) {
        return `Found issue ${result.issue.identifier}: "${result.issue.title}"\nURL: ${result.issue.url}`;
      }
      break;
    case "fetch_latest_issue":
      if (result.issue) {
        return `Latest issue: ${result.issue.identifier} - "${result.issue.title}"`;
      }
      break;
    case "list_recent_issues":
      if (result.issues) {
        if (result.issues.length === 0) return "No issues found.";
        const list = result.issues.map((i) => `• ${i.identifier}: ${i.title}`).join("\n");
        return `Found ${result.issues.length} issues:\n${list}`;
      }
      break;
    case "create_pull_request":
      if (result.prUrl) {
        return `PR #${result.prNumber} created successfully!\nView it here: ${result.prUrl}`;
      }
      if (result.message) {
        return result.message;
      }
      break;
    case "get_repository_info":
      if (result.owner) {
        return `Repository: ${result.owner}/${result.repo}`;
      }
      break;
  }
  return JSON.stringify(result);
}

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

async function main() {
  loadDotEnv();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable is not set.");
    console.error("Get your free API key at: https://aistudio.google.com/app/apikey");
    process.exit(1);
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  console.log(`\nUsing model: ${model}`);

  const llm = new GeminiLLM(apiKey);
  let config = loadConfig();

  config.autonomyLevel = await promptForAutonomyLevel(config.autonomyLevel);
  config.confirmedActions = [];
  saveConfig(config);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = () => new Promise((resolve) => {
    rl.question("You: ", resolve);
  });

  console.log("\nAgent ready! Type your request or 'exit' to quit.\n");

  while (true) {
    const input = await ask();
    const trimmed = input.trim();
    
    if (trimmed.toLowerCase() === "exit") {
      console.log("Goodbye!");
      rl.close();
      process.exit(0);
    }

    if (!trimmed) continue;

    try {
      const response = await llm.chat(trimmed, tools);

      if (response.text) {
        console.log(`\nAgent: ${response.text}\n`);
      }

      if (response.functionCalls.length > 0) {
        for (const call of response.functionCalls) {
          const { name, args } = call;
          console.log(`\nAgent: Calling tool "${name}"...`);

          const shouldRun = await shouldExecute(config, name, args);
          if (!shouldRun) {
            console.log("Agent: Skipped by user.");
            continue;
          }

          const result = await executeTool(name, args, {
            LINEAR_API_KEY: process.env.LINEAR_API_KEY,
            GITHUB_TOKEN: process.env.GITHUB_TOKEN,
            REPO_PATH: process.env.REPO_PATH,
          });

          const formattedResult = formatToolResult(name, result);
          console.log(`\nAgent: ${formattedResult}\n`);

          const followUp = await llm.chat(`Tool ${name} returned: ${JSON.stringify(result)}`);
          if (followUp.text) {
            console.log(`\nAgent: ${followUp.text}\n`);
          }
        }
      } else if (!response.text) {
        console.log(`\nAgent: I can't answer this — I don't have this configured.\n`);
      }
    } catch (error) {
      console.error(`\nAgent Error: ${error.message}\n`);
    }
  }
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
