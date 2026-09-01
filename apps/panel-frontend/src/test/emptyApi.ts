import { vi } from 'vitest';

/**
 * What every read endpoint answers on a deployment where nothing has been
 * created yet.
 *
 * Thirty-nine of the panel's forty-five screens were never mounted by a test,
 * and the reason is here: mounting one means answering the six to ten queries
 * it fires, and every file that tried wrote its own fixtures. So they are
 * written once — EMPTY but WELL-FORMED, which is the state a fresh install is
 * actually in, and the one a screen is least likely to have been tried against.
 *
 * "Well-formed" is not a matter of taste: `emptyApi.mirror.test.ts` reads the
 * declared return type of every entry below out of `lib/api.ts` and fails when
 * the two disagree. Without that this file would be a second, quieter copy of
 * the API contract — and the first draft already had one: `getDashboardOverview`
 * was written as `{ nodes: [], users: {} }`, which is missing `traffic`, and
 * DashboardPage dereferences `traffic.todayBytes` on its first render.
 *
 * The mirror compares TOP-LEVEL keys only. That is enough for the failure this
 * exists to prevent (a whole section of the response missing) and is stated
 * here rather than left to be discovered.
 */
export const EMPTY_API: Record<string, unknown> = {
  // ───── lists: the plural key and nothing in it ─────
  listUsers: { users: [], total: 0, page: 1, limit: 50 },
  listNodes: { nodes: [], total: 0, page: 1, limit: 100 },
  listProfiles: { profiles: [] },
  listBindings: { bindings: [] },
  listHosts: { hosts: [] },
  listSquads: { squads: [] },
  listCascades: { cascades: [] },
  listRegions: { regions: [] },
  listRoutePolicies: { policies: [] },
  listRoutingPresets: { presets: [] },
  listSrrRules: { rules: [] },
  listApiTokens: { tokens: [] },
  listUserTags: { tags: [] },
  listUserDevices: { devices: [] },
  listUserWgDevices: { devices: [] },
  // Declared as a bare array, not as `{ groups: [] }`. Written down because the
  // first draft guessed the wrapper and the mirror refused it.
  listEgressCatalogue: [],
  fetchUserEndpoints: { endpoints: [] },

  // ───── single records: "there is none" is null, not an empty object ─────
  findNode: null,
  getGeoBuild: null,

  // ───── geo ─────
  getGeoSources: { sources: [] },
  getGeoCategories: { categories: [] },
  getGeoCategoryUsage: { usage: {} },
  getSourceCategories: { geosite: [], geoip: [], errors: [] },
  getSourceCategoryPreview: { entries: [], total: 0, truncated: false },

  // ───── recipes ─────
  getRecipeSources: { sources: [] },
  getRecipeRegistry: {
    fetchedAt: '2026-08-01T00:00:00.000Z',
    source: 'icecompany-tech/recipes@main',
    recipes: [],
    stale: false,
  },

  // ───── settings and identity ─────
  // Both settings blobs are entirely optional fields: absent IS the empty
  // deployment, and a screen that needs a default has to carry it.
  getSettings: {},
  getPublicSettings: {},
  get2faStatus: { enabled: false },
  fetchAuthStatus: {
    authentication: { password: { enabled: true } },
    registration: { enabled: false },
    panel: { publicUrl: 'http://localhost:3000', subscriptionPathPrefix: '/sub' },
  },
  getSystemVersion: {
    current: '0.2.0',
    latest: null,
    updateAvailable: false,
    releaseUrl: null,
    stars: null,
    checkedAt: null,
  },

  // ───── on-demand probes ─────
  // A number, not an object. Same reason as listEgressCatalogue.
  getNextFreePort: 1337,
  getNodeExposure: { checked: false },
  getCascadeStatus: { done: true, hops: [] },
  getProfileHostFields: { fields: {} },
  // Unreachable, not "answered with nothing": on a panel where nothing has been
  // set up there is no node to answer, and the two are different states the
  // screen renders differently. This one also exercises the branch that carries
  // a reason.
  listNodeCores: {
    reachable: false,
    reason: 'connect ECONNREFUSED',
    cores: [],
  },

  // ───── the two aggregates, which are all shape and no rows ─────
  getDashboardOverview: {
    users: {
      total: 0,
      byStatus: {},
      onlineNow: 0,
      onlineToday: 0,
      onlineThisWeek: 0,
      neverOnline: 0,
    },
    traffic: {
      todayBytes: 0,
      yesterdayBytes: 0,
      last7dBytes: 0,
      last30dBytes: 0,
      calendarMonthBytes: 0,
      currentYearBytes: 0,
      prev7dBytes: 0,
      prev30dBytes: 0,
      lastCalendarMonthBytes: 0,
      lastYearBytes: 0,
      last24hHourly: [],
    },
    system: { onlineNodeCount: 0, totalNodeCount: 0 },
    inventory: { profileCount: 0, squadCount: 0, hostCount: 0 },
    host: {
      cpu: { loadPercent: null, samplePercent: 0, cores: 1, loadavg: [0, 0, 0] },
      memory: { totalBytes: 0, usedBytes: 0, usedPercent: 0 },
      // A container without a readable mount reports null here, and that is the
      // ordinary case in docker, not an error state.
      disk: null,
      process: { rssBytes: 0, heapUsedBytes: 0, heapLimitBytes: 0, uptimeSeconds: 0 },
    },
    nodes: [],
    byProtocol: [],
    topUsersToday: [],
    recentEvents: [],
  },
  getInsights: {
    windowDays: 30,
    subRequests: { total: 0, uniqueUsers: 0, byClient: [], byHourUtc: [] },
    hwid: {
      totalDevices: 0,
      usersWithDevices: 0,
      avgDevicesPerUser: 0,
      distribution: [],
      atOrOverLimit: 0,
    },
  },
};

/**
 * A read endpoint is one whose name says it only reads.
 *
 * `[A-Z0-9]`, not `[A-Z]`: the boundary is there so `getter`-shaped names do
 * not match, and the first draft's `[A-Z]` quietly excluded `get2faStatus` —
 * which would then have been left UNMOCKED and made a real HTTP call out of a
 * jsdom test. Caught by the mirror's second direction, which asks whether
 * anything in EMPTY_API is not a read endpoint.
 */
export const isReadEndpoint = (name: string): boolean =>
  /^(list|get|find|fetch)[A-Z0-9]/.test(name);

/**
 * Build the module object for `vi.mock('../lib/api', ...)`: every read endpoint
 * answers its empty response, everything else is left alone.
 *
 * A read endpoint with no declared empty response does NOT quietly answer
 * `undefined` — it rejects with its own name in the message. A screen that
 * reaches an endpoint nobody thought about has to say so, or this whole file
 * turns into a way of not noticing.
 */
export function emptyApiModule(
  actual: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value !== 'function' || !isReadEndpoint(name)) continue;
    out[name] = name in EMPTY_API
      ? vi.fn(async () => structuredClone(EMPTY_API[name]))
      : vi.fn(async () => {
          throw new Error(
            `emptyApi: ${name}() has no empty response declared. Add one to ` +
              `src/test/emptyApi.ts (the mirror there will hold it to the type).`,
          );
        });
  }
  return { ...out, ...overrides };
}
