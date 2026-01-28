/**
 * Configuration management for Claude Azure
 */
import Conf from "conf";
import { homedir } from "os";
import { join } from "path";

export interface AzureConfig {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  deployments: {
    opus?: string;
    sonnet?: string;
    haiku?: string;
  };
  router?: string; // Single deployment for model router mode
  reasoningEffort?: "low" | "medium" | "high" | "extra_high";
  reasoningModel?: string;
}

export interface AppConfig {
  provider: "azure" | "openai" | "anthropic";
  azure?: AzureConfig;
  openai?: {
    apiKey: string;
    baseUrl: string;
  };
  anthropic?: {
    apiKey: string;
  };
}

const config = new Conf<AppConfig>({
  projectName: "claude-azure",
  cwd: join(homedir(), ".claude-azure"),
});

export function getConfig(): AppConfig | null {
  const provider = config.get("provider");
  if (!provider) return null;

  return {
    provider,
    azure: config.get("azure"),
    openai: config.get("openai"),
    anthropic: config.get("anthropic"),
  };
}

export function setConfig(newConfig: AppConfig): void {
  config.set("provider", newConfig.provider);
  if (newConfig.azure) config.set("azure", newConfig.azure);
  if (newConfig.openai) config.set("openai", newConfig.openai);
  if (newConfig.anthropic) config.set("anthropic", newConfig.anthropic);
}

export function configExists(): boolean {
  return !!config.get("provider");
}

export function getConfigPath(): string {
  return config.path;
}

export function clearConfig(): void {
  config.clear();
}

// Dynamic reasoning effort - can be changed without restart
export function getReasoningEffort():
  | "low"
  | "medium"
  | "high"
  | "extra_high"
  | undefined {
  const azure = config.get("azure");
  return azure?.reasoningEffort;
}

export function setReasoningEffort(
  level: "low" | "medium" | "high" | "extra_high",
): void {
  const azure = config.get("azure");
  if (azure) {
    azure.reasoningEffort = level;
    config.set("azure", azure);
  }
}
