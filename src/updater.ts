/**
 * Auto-updater for Claude Azure
 * Checks GitHub for updates and auto-updates when available
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_URL = 'https://github.com/schwarztim/claude-azure';
const CACHE_FILE = join(homedir(), '.claude-azure', 'update-cache.json');
const CACHE_DURATION = 3600000; // 1 hour

interface UpdateCache {
  lastCheck: number;
  latestSha: string;
  currentSha: string;
}

function getLocalSha(): string {
  try {
    // Get SHA from git if in repo
    const repoRoot = join(__dirname, '..', '..');
    if (existsSync(join(repoRoot, '.git'))) {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim();
      return sha.slice(0, 7);
    }
  } catch {
    // Ignore
  }
  return 'unknown';
}

function loadCache(): UpdateCache | null {
  try {
    if (existsSync(CACHE_FILE)) {
      return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch {
    // Ignore
  }
  return null;
}

function saveCache(cache: UpdateCache): void {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {
    // Ignore
  }
}

export async function checkForUpdates(verbose = false): Promise<string | null> {
  const cache = loadCache();
  const now = Date.now();

  // Use cache if fresh
  if (cache && now - cache.lastCheck < CACHE_DURATION) {
    if (cache.latestSha !== cache.currentSha) {
      return `\x1b[33m● Update available!\x1b[0m Run: claude-azure --update`;
    }
    return null;
  }

  // Check GitHub
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(
      'https://api.github.com/repos/schwarztim/claude-azure/commits/main',
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      const latestSha = (data.sha as string).slice(0, 7);
      const currentSha = getLocalSha();

      saveCache({ lastCheck: now, latestSha, currentSha });

      if (latestSha !== currentSha && currentSha !== 'unknown') {
        return `\x1b[33m● Update available!\x1b[0m Run: claude-azure --update`;
      }
    }
  } catch {
    // Silently fail
  }

  return null;
}

export async function doUpdate(): Promise<boolean> {
  const repoRoot = join(__dirname, '..', '..');

  if (!existsSync(join(repoRoot, '.git'))) {
    console.error('Error: Not a git repository. Cannot update.');
    return false;
  }

  console.log('Updating from GitHub...');

  try {
    // Git pull
    execFileSync('git', ['pull', 'origin', 'main'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    // npm install
    console.log('Installing dependencies...');
    execFileSync('npm', ['install'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    // npm build
    console.log('Building...');
    execFileSync('npm', ['run', 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    console.log('\x1b[32m✓\x1b[0m Update complete!');

    // Clear cache
    saveCache({ lastCheck: 0, latestSha: '', currentSha: '' });

    return true;
  } catch (error: any) {
    console.error('Update failed:', error.message);
    return false;
  }
}
