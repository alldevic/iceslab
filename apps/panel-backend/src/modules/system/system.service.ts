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

/**
 * A panel version as semver 2.0 reads it: a leading v stripped, the build
 * metadata (+...) dropped, which takes no part in precedence, and the
 * pre-release (-rc.1) kept as its dot-separated identifiers.
 *
 * Not compareCoreVersions (shared core-versions.ts): that one refuses to order
 * suffixes on purpose, because the cores' upstreams give them opposite
 * meanings. The panel's own tags are semver, and a suffix there is a
 * pre-release.
 */
function parseSemver(v: string): { core: number[]; pre: string[] } {
  const noBuild = v.trim().replace(/^v/i, '').split('+')[0]!;
  const dash = noBuild.indexOf('-');
  const coreText = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const preText = dash === -1 ? '' : noBuild.slice(dash + 1);
  return {
    core: coreText.split('.').map((n) => Number.parseInt(n, 10) || 0),
    pre: preText === '' ? [] : preText.split('.'),
  };
}

/** semver 2.0 §11.4: numeric identifiers numerically and below alphanumeric
 *  ones, those in ASCII order, and a shorter set first when all before agree. */
function comparePre(a: string[], b: string[]): number {
  // No pre-release outranks any: 0.3.0 is newer than 0.3.0-rc.1 (§11.3).
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** True when `latest` is strictly newer than `current` by semver 2.0
 *  precedence: a final is newer than its own pre-releases (a panel on
 *  0.3.0-rc.1 is told about 0.3.0), rc.2 newer than rc.1. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  const len = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < len; i++) {
    const x = a.core[i] ?? 0;
    const y = b.core[i] ?? 0;
    if (x !== y) return x > y;
  }
  return comparePre(a.pre, b.pre) > 0;
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
