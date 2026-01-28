#!/usr/bin/env node
/**
 * Claude Azure CLI - Claude Code with native Azure OpenAI support
 */
import { spawn, execFileSync } from "child_process";
import { createServer } from "net";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import chalk from "chalk";
import ora from "ora";
import { program } from "commander";
import inquirer from "inquirer";
import {
  getConfig,
  setConfig,
  configExists,
  clearConfig,
  getReasoningEffort,
  setReasoningEffort,
} from "./config.js";
import { runWizard } from "./wizard.js";
import { startProxy } from "./proxy.js";
import { checkForUpdates, doUpdate } from "./updater.js";
import { setupMcps, isMcpInstalled } from "./mcp-setup.js";

// Find a free port
function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// Find claude binary
function findClaude(): string | null {
  const homeDir = homedir();
  const isWindows = process.platform === "win32";

  const commonPaths = isWindows
    ? [
        join(homeDir, "AppData", "Local", "Programs", "Claude", "claude.exe"),
        join(homeDir, ".claude", "bin", "claude.exe"),
        join(homeDir, ".local", "bin", "claude.exe"),
      ]
    : [
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
        join(homeDir, ".local", "bin", "claude"),
        join(homeDir, ".claude", "bin", "claude"),
      ];

  for (const path of commonPaths) {
    if (existsSync(path)) return path;
  }

  try {
    const whichCmd = isWindows ? "where" : "which";
    return (
      execFileSync(whichCmd, ["claude"], { encoding: "utf-8" })
        .trim()
        .split("\n")[0] || null
    );
  } catch {
    return null;
  }
}

// Wait for proxy
async function waitForProxy(port: number, timeout = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      // Keep trying
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function main() {
  // Handle 'reasoning' subcommand before commander parses
  if (process.argv[2] === "reasoning") {
    const level = process.argv[3] as
      | "low"
      | "medium"
      | "high"
      | "extra_high"
      | undefined;
    const validLevels = ["low", "medium", "high", "extra_high"];

    if (!level) {
      // Show current level
      const current = getReasoningEffort();
      console.log(
        chalk.blue("Current reasoning effort:"),
        current || "not set (default: medium)",
      );
      console.log();
      console.log(chalk.gray("Usage: claude-azure reasoning <level>"));
      console.log(chalk.gray("Levels: low, medium, high, extra_high"));
      process.exit(0);
    }

    if (!validLevels.includes(level)) {
      console.error(
        chalk.red("Error:"),
        `Invalid level "${level}". Valid options: ${validLevels.join(", ")}`,
      );
      process.exit(1);
    }

    setReasoningEffort(level);
    const icons: Record<string, string> = {
      low: "🐇",
      medium: "⚖️",
      high: "🧠",
      extra_high: "🚀",
    };
    console.log(
      chalk.green("✓"),
      `Reasoning effort set to ${icons[level]} ${chalk.bold(level)}`,
    );
    console.log(
      chalk.gray(
        "  Change takes effect on next API request (no restart needed)",
      ),
    );
    process.exit(0);
  }

  program
    .name("claude-azure")
    .description("Claude Code with native Azure OpenAI support")
    .version("1.1.0")
    .option("--setup", "Run the setup wizard")
    .option("--reconfigure", "Reconfigure settings")
    .option("--verbose", "Show proxy logs")
    .option("--reset", "Clear all configuration")
    .option("--update", "Update from GitHub")
    .allowUnknownOption(true)
    .parse();

  const options = program.opts();
  const claudeArgs = program.args;

  // Handle update
  if (options.update) {
    await doUpdate();
    // Also update MCPs
    console.log("\nUpdating MCPs...");
    await setupMcps(true, true);
    process.exit(0);
  }

  // Handle reset
  if (options.reset) {
    clearConfig();
    console.log(chalk.green("✓") + " Configuration cleared");
    process.exit(0);
  }

  // Handle setup/reconfigure
  if (options.setup || options.reconfigure) {
    await runWizard();
    // Install MCPs on setup
    console.log("\nSetting up web search capability...");
    await setupMcps(true);
    if (claudeArgs.length === 0) {
      process.exit(0);
    }
  }

  // Check for updates (quick, cached)
  const updateMsg = await checkForUpdates();
  if (updateMsg) {
    console.log(updateMsg);
    console.log();
  }

  // Check for configuration
  if (!configExists()) {
    console.log();
    console.log(chalk.cyan.bold("  Welcome to Claude Azure!"));
    console.log(
      chalk.gray("  Use Claude Code with Azure OpenAI, OpenAI, or Anthropic"),
    );
    console.log();
    await runWizard();

    // Install MCPs on first run
    console.log("\nSetting up web search capability...");
    await setupMcps(true);
  }

  const config = getConfig();
  if (!config) {
    console.error(
      chalk.red("Error:") + " No configuration found. Run with --setup",
    );
    process.exit(1);
  }

  // Find claude binary
  const claudeBinary = findClaude();
  if (!claudeBinary) {
    console.error(
      chalk.red("Error:") +
        " Claude Code not found. Install from https://claude.ai/code",
    );
    process.exit(1);
  }

  // Ensure MCPs installed (silent check)
  if (!isMcpInstalled()) {
    console.log("Installing web search MCP...");
    await setupMcps(false);
  }

  // Direct passthrough for Anthropic
  if (config.provider === "anthropic") {
    console.log(chalk.yellow("◖A◗") + chalk.gray(" Using Anthropic directly"));
    const env = { ...process.env, ANTHROPIC_API_KEY: config.anthropic!.apiKey };
    const child = spawn(claudeBinary, claudeArgs, { env, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code || 0));
    return;
  }

  // Prompt for reasoning effort when using gpt-5.* deployments
  if (config.provider === "azure" && config.azure) {
    const deploymentNames = [
      config.azure.router,
      config.azure.deployments?.opus,
      config.azure.deployments?.sonnet,
      config.azure.deployments?.haiku,
    ].filter(Boolean) as string[];
    const reasoningModel =
      deploymentNames.find((name) => name.toLowerCase() === "gpt-5.2-codex") ||
      deploymentNames.find((name) => name.toLowerCase().includes("gpt-5"));

    if (reasoningModel) {
      const current = config.azure.reasoningEffort;

      // Only prompt if not already configured AND running in interactive terminal
      const shouldPrompt = !current && process.stdin.isTTY;
      const reasoningEffort = current || "medium"; // Default to medium if not set

      if (shouldPrompt) {
        const choices = [
          {
            value: "low",
            label: "Low",
            description: "Fast responses with lighter reasoning",
          },
          {
            value: "medium",
            label: "Medium",
            description:
              "Balances speed and reasoning depth for everyday tasks",
          },
          {
            value: "high",
            label: "High",
            description: "Greater reasoning depth for complex problems",
          },
          {
            value: "extra_high",
            label: "Extra high",
            description: "Extra high reasoning depth for complex problems",
            warning:
              "⚠ Extra high reasoning effort can quickly consume Plus plan",
          },
        ].map((choice) => {
          const isCurrent = choice.value === current;
          const isDefault = choice.value === "medium";
          const suffix = isCurrent
            ? " (current)"
            : isDefault
              ? " (default)"
              : "";
          const warning = choice.warning
            ? ` ${chalk.yellow(choice.warning)}`
            : "";
          return {
            value: choice.value,
            name: `${choice.label}${suffix}  ${chalk.gray(choice.description)}${warning}`,
          };
        });

        const promptResult = await inquirer.prompt([
          {
            type: "list",
            name: "reasoningEffort",
            message: `Select Reasoning Level for ${reasoningModel}`,
            choices,
            default: reasoningEffort,
          },
        ]);

        config.azure.reasoningEffort = promptResult.reasoningEffort;
        config.azure.reasoningModel = reasoningModel;
        setConfig(config);
      } else {
        // Not prompting - ensure config has the default/current value
        config.azure.reasoningEffort = reasoningEffort;
        config.azure.reasoningModel = reasoningModel;
        setConfig(config);
      }
    }
  }

  // Need proxy for Azure/OpenAI
  const port = await findFreePort();

  // Show banner
  console.log();
  if (config.provider === "azure") {
    console.log(chalk.blue("  ╔═╗"));
    console.log(
      chalk.blue("  ║") +
        chalk.bold.blue("Q") +
        chalk.blue("║") +
        chalk.gray(" Claude Azure"),
    );
    console.log(chalk.blue("  ╚═╝"));
  } else {
    console.log(chalk.green("  ◖O◗") + chalk.gray(" Claude OpenAI"));
  }
  console.log();

  // Start proxy
  const spinner = ora("Starting proxy...").start();

  if (config.provider === "azure" && config.azure) {
    await startProxy({
      port,
      azure: config.azure,
      verbose: !!options.verbose,
    });
  } else if (config.provider === "openai" && config.openai) {
    spinner.fail("OpenAI proxy not yet implemented");
    process.exit(1);
  }

  // Wait for proxy
  const ready = await waitForProxy(port);
  if (!ready) {
    spinner.fail("Proxy failed to start");
    process.exit(1);
  }

  spinner.succeed(`Proxy ready on port ${port}`);
  console.log();

  // Launch Claude with proxy
  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  };
  delete env.ANTHROPIC_API_KEY;

  const child = spawn(claudeBinary, claudeArgs, { env, stdio: "inherit" });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  child.on("exit", (code) => process.exit(code || 0));
}

main().catch((err) => {
  console.error(chalk.red("Error:"), err.message);
  process.exit(1);
});
