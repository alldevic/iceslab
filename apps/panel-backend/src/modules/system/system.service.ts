import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ROADMAP D1: "update available" check. Compares the running panel version
 * against the latest GitHub release tag. Best-effort by design: the panel must
 * never break (or even slow down a request) because GitHub is unreachable, so
 * every failure path degrades to `latest: null` / `updateAvailable: false`.
 */

// Repo to check. Override via env for forks / self-hosted mirrors.
const GITHUB_REPO = process.env.GITHUB_REPO ?? 'icecompany-tech/iceslab';
// The repo is private, so the releases API needs a token to return a tag.
// Without it the check simply degrades to "unknown latest" (no nag, no error).
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const CHECK_TTL_MS = 6 * 60 * 60 * 1000; // re-check GitHub at most every 6h
const FETCH_TIMEOUT_MS = 4000;

let currentVersionCache: string | null = null;

export function readCurrentVersion(): string {
  if (currentVersionCache) return currentVersionCache;
  // The process runs with cwd = the backend package dir in both dev
  // (`pnpm --filter @iceslab/panel-backend start`) and the Docker image
  // (WORKDIR /app/apps/panel-backend), so its package.json is a stable,
  // dependency-free source of truth for the running version.
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
    ) as { version?: string };
    currentVersionCache = pkg.version ?? 'unknown';
  } catch {
    currentVersionCache = process.env.APP_VERSION ?? 'unknown';
  }
  return currentVersionCache;
}

interface LatestCache {
  latest: string | null;
  releaseUrl: string | null;
  /** Stargazer count for the topbar chip, null when GitHub is unreachable. */
  stars: number | null;
  checkedAt: number; // epoch ms
}
let latestCache: LatestCache | null = null;
let inflight: Promise<LatestCache> | null = null;

/** Strip a leading v, drop any pre-release/build suffix, split to numbers. */
function parseSemver(v: string): number[] {
  const core = v.replace(/^v/i, '').split(/[-+]/)[0];
  return core.split('.').map((n) => Number.parseInt(n, 10) || 0);
}

/** True when `latest` is strictly newer than `current` (numeric major.minor.patch). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'iceslab-panel',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

/** One GitHub GET with the shared timeout. Returns null on any failure. */
async function githubGet<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
      headers: githubHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // network / abort / parse: degrade silently.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLatest(): Promise<LatestCache> {
  const checkedAt = Date.now();
  // Two independent calls behind one 6h cache entry: the release tag drives
  // the update nag, the repo record drives the star count in the topbar.
  // Either can fail on its own without taking the other down.
  const [release, repo] = await Promise.all([
    githubGet<{ tag_name?: string; html_url?: string }>('/releases/latest'),
    githubGet<{ stargazers_count?: number }>(''),
  ]);
  return {
    latest: release?.tag_name?.trim() || null,
    releaseUrl: release?.html_url ?? null,
    stars: typeof repo?.stargazers_count === 'number' ? repo.stargazers_count : null,
    checkedAt,
  };
}

async function getLatest(): Promise<LatestCache> {
  if (latestCache && Date.now() - latestCache.checkedAt < CHECK_TTL_MS) {
    return latestCache;
  }
  // Single-flight: collapse concurrent refreshes into one GitHub call.
  if (!inflight) {
    inflight = fetchLatest().then((r) => {
      latestCache = r;
      inflight = null;
      return r;
    });
  }
  return inflight;
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  stars: number | null;
  checkedAt: string | null;
}

export async function getVersionInfo(): Promise<VersionInfo> {
  const current = readCurrentVersion();
  const { latest, releaseUrl, stars, checkedAt } = await getLatest();
  const updateAvailable = latest != null && current !== 'unknown' && isNewer(latest, current);
  return {
    current,
    latest,
    updateAvailable,
    releaseUrl,
    stars,
    checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null,
  };
}
