/**
 * MCP Setup for Claude Azure
 * Auto-installs web-search MCP for backends that lack web access
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const MCP_DIR = join(homedir(), '.claude-azure', 'mcps');
const MCP_CONFIG = join(homedir(), '.claude', 'user-mcps.json');
const SETTINGS_FILE = join(homedir(), '.claude', 'settings.json');
const WEB_SEARCH_REPO = 'https://github.com/schwarztim/web-search-mcp.git';

export function isMcpInstalled(): boolean {
  return existsSync(join(MCP_DIR, 'web-search-mcp', 'dist', 'index.js'));
}

export function isMcpRegistered(): boolean {
  try {
    if (!existsSync(MCP_CONFIG)) return false;
    const config = JSON.parse(readFileSync(MCP_CONFIG, 'utf-8'));
    // user-mcps.json uses mcpServers wrapper
    return 'web-search' in (config.mcpServers || {});
  } catch {
    return false;
  }
}

export async function installWebSearchMcp(verbose = false): Promise<boolean> {
  const mcpPath = join(MCP_DIR, 'web-search-mcp');

  try {
    mkdirSync(MCP_DIR, { recursive: true });

    // Clone or update
    if (existsSync(mcpPath)) {
      if (verbose) console.log('Updating web-search MCP...');
      try {
        execFileSync('git', ['pull'], { cwd: mcpPath, stdio: verbose ? 'inherit' : 'pipe' });
      } catch {
        // If pull fails, try fresh clone
        execFileSync('rm', ['-rf', mcpPath]);
        return installWebSearchMcp(verbose);
      }
    } else {
      if (verbose) console.log('Installing web-search MCP...');
      execFileSync('git', ['clone', WEB_SEARCH_REPO, mcpPath], {
        stdio: verbose ? 'inherit' : 'pipe',
      });
    }

    // npm install
    if (verbose) console.log('Installing dependencies...');
    execFileSync('npm', ['install'], { cwd: mcpPath, stdio: verbose ? 'inherit' : 'pipe' });

    // npm build
    if (verbose) console.log('Building...');
    execFileSync('npm', ['run', 'build'], { cwd: mcpPath, stdio: verbose ? 'inherit' : 'pipe' });

    return true;
  } catch (error: any) {
    if (verbose) console.error('MCP install failed:', error.message);
    return false;
  }
}

function enableMcpInSettings(mcpName: string, verbose = false): boolean {
  try {
    if (!existsSync(SETTINGS_FILE)) {
      if (verbose) console.log('settings.json not found, skipping enable');
      return false;
    }

    const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));

    // Ensure enabledMcpjsonServers exists
    if (!settings.enabledMcpjsonServers) {
      settings.enabledMcpjsonServers = [];
    }

    // Add MCP if not already enabled
    if (!settings.enabledMcpjsonServers.includes(mcpName)) {
      settings.enabledMcpjsonServers.push(mcpName);
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      if (verbose) console.log(`Enabled ${mcpName} in settings.json`);
    }

    return true;
  } catch (error: any) {
    if (verbose) console.error('Failed to enable MCP in settings:', error.message);
    return false;
  }
}

export function registerWebSearchMcp(verbose = false): boolean {
  const indexPath = join(MCP_DIR, 'web-search-mcp', 'dist', 'index.js');

  if (!existsSync(indexPath)) {
    if (verbose) console.error('web-search MCP not built');
    return false;
  }

  try {
    // Ensure .claude directory exists
    mkdirSync(join(homedir(), '.claude'), { recursive: true });

    // Load or create config (user-mcps.json uses mcpServers wrapper)
    let config: Record<string, any> = { mcpServers: {} };
    if (existsSync(MCP_CONFIG)) {
      config = JSON.parse(readFileSync(MCP_CONFIG, 'utf-8'));
      if (!config.mcpServers) config.mcpServers = {};
    }

    // Add web-search
    config.mcpServers['web-search'] = {
      command: 'node',
      args: [indexPath],
    };

    // Write back
    writeFileSync(MCP_CONFIG, JSON.stringify(config, null, 2));

    // Also enable in settings.json
    enableMcpInSettings('web-search', verbose);

    if (verbose) console.log(`Registered web-search MCP in ${MCP_CONFIG}`);
    return true;
  } catch (error: any) {
    if (verbose) console.error('MCP registration failed:', error.message);
    return false;
  }
}

export async function setupMcps(verbose = false, force = false): Promise<void> {
  // Check for npm and git
  try {
    execFileSync('which', ['npm'], { stdio: 'pipe' });
    execFileSync('which', ['git'], { stdio: 'pipe' });
  } catch {
    if (verbose) console.log('npm or git not found, skipping MCP setup');
    return;
  }

  // Install if needed
  if (force || !isMcpInstalled()) {
    const success = await installWebSearchMcp(verbose);
    if (!success) return;
  }

  // Register if needed
  if (!isMcpRegistered()) {
    const success = registerWebSearchMcp(verbose);
    if (success) {
      console.log('\x1b[36m●\x1b[0m Web search MCP installed - your model can now search the web!');
    }
  } else if (verbose) {
    console.log('web-search MCP already registered');
  }
}
