import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", ".agent-config.json");

const DEFAULT_CONFIG = {
  autonomyLevel: null,
  confirmedActions: [],
};

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const data = readFileSync(CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const AUTONOMY_LABELS = {
  confirmAlways: "1 - Ask for confirmation each time",
  confirmOnce: "2 - Ask once, remember my choice for this run",
  autoExecute: "3 - Auto-execute without asking",
};

export async function promptForAutonomyLevel(previousLevel) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log("\nHow would you like me to work this run?\n");
    console.log("  1. Ask for confirmation each time");
    console.log("  2. Ask once, remember my choice for this run");
    console.log("  3. Auto-execute without asking\n");
    if (previousLevel) {
      console.log(`(Last run: ${AUTONOMY_LABELS[previousLevel] || previousLevel}. Press Enter to keep it.)\n`);
    }

    rl.question("Enter choice (1/2/3): ", (answer) => {
      rl.close();
      const choice = answer.trim();
      switch (choice) {
        case "1":
          resolve("confirmAlways");
          break;
        case "2":
          resolve("confirmOnce");
          break;
        case "3":
          resolve("autoExecute");
          break;
        case "":
          if (previousLevel) {
            resolve(previousLevel);
          } else {
            console.log("No previous choice found, defaulting to 'confirmOnce'");
            resolve("confirmOnce");
          }
          break;
        default:
          console.log("Invalid choice, defaulting to 'confirmOnce'");
          resolve("confirmOnce");
      }
    });
  });
}

export async function promptConfirmation(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export async function shouldExecute(config, toolName, args) {
  const { autonomyLevel, confirmedActions } = config;

  if (autonomyLevel === "autoExecute") {
    return true;
  }

  if (autonomyLevel === "confirmAlways") {
    const message = `Execute ${toolName} with args: ${JSON.stringify(args, null, 2)}?`;
    return await promptConfirmation(message);
  }

  if (autonomyLevel === "confirmOnce") {
    const actionKey = `${toolName}:${JSON.stringify(args)}`;
    if (confirmedActions.includes(actionKey)) {
      return true;
    }

    const message = `Execute ${toolName} with args: ${JSON.stringify(args, null, 2)}?`;
    const confirmed = await promptConfirmation(message);

    if (confirmed) {
      config.confirmedActions.push(actionKey);
      saveConfig(config);
    }

    return confirmed;
  }

  return false;
}
