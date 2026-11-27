import { AxiosError, type AxiosResponse } from 'axios';
import { vi } from 'vitest';
import { api } from '@/lib/net/client';
import type { getDashboardOverview, getInsights } from '@/lib/domain/dashboard';
import type { listUsers, listUserTags } from '@/lib/domain/users';
import type { listNodes, listRegions } from '@/lib/domain/nodes';
import type { listProfiles, listBindings } from '@/lib/domain/profiles';
import type { listSquads } from '@/lib/domain/squads';
import type { listHosts } from '@/lib/domain/hosts';
import type { listCascades } from '@/lib/domain/cascades';
import type { listAudit } from '@/lib/domain/audit';
import type { listSrrRules } from '@/lib/domain/srr';
import type { listTemplates } from '@/lib/domain/subscriptionTemplates';
import type { listGeoSets } from '@/lib/domain/geoSets';
import type { listNamedOutbounds } from '@/lib/domain/namedOutbounds';
import type { getPresetNodes, listRoutePolicies, listRoutingPresets } from '@/lib/domain/routePolicies';
import type { listNodePolicies } from '@/lib/domain/nodePolicies';
import type { getRecipeRegistry, getRecipeSources } from '@/lib/domain/recipes';
import type { getPublicSettings, getSettings, getSystemVersion, listApiTokens } from '@/lib/domain/settings';
import type { fetchAuthStatus, get2faStatus } from '@/lib/auth/api';

/**
 * What the panel's API answers on a panel with nothing in it: no node, user,
 * profile, host, squad. Keyed by request path, installed on the one axios
 * instance every screen goes through (`lib/net/client`), so a screen is
 * mounted as it is and only the wire is replaced.
 *
 * Each body is typed by the return type of the function that reads it
 * (`Awaited<ReturnType<typeof listNodes>>`), so a type change in `lib/domain`
 * breaks `tsc` here instead of a screen at runtime. The shape against the
 * BACKEND is not checked here, only against the frontend's own type.
 *
 * A path nobody wrote down is NOT answered with `{}`: the call is recorded in
 * `unknown` and rejected with the path in the message. React Query swallows
 * the rejection into an error state, so the test reads `unknown` too.
 *
 * Requests that change something (POST/PUT/PATCH/DELETE) are recorded the same
 * way and rejected unless `onWrite` answers them; the log holds both kinds, so
 * a form test can read what a screen sent without redoing this module.
 */

type Reply<F extends (...a: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

/** The answer of a read whose record does not exist: a 404 as the backend words it. */
export const NOT_FOUND = Symbol('emptyApi.notFound');

export interface RouteEntry {
  re: RegExp;
  /** The body, or `NOT_FOUND`. A function sees the request's query params. */
  reply: unknown | ((req: { url: string; params: Record<string, unknown> }) => unknown);
}

/** `typed<typeof listX>(re, body)`: the body is checked against what `listX` returns. */
function typed<F extends (...a: never[]) => Promise<unknown>>(re: RegExp, reply: Reply<F>): RouteEntry {
  return { re, reply };
}

const none = (re: RegExp): RouteEntry => ({ re, reply: NOT_FOUND });

export const EMPTY_ROUTES: RouteEntry[] = [
  { re: /^\/health$/, reply: { status: 'ok' } },
  typed<typeof fetchAuthStatus>(/^\/api\/auth\/status$/, {
    authentication: { password: { enabled: true } },
    registration: { enabled: false },
  }),
  typed<typeof get2faStatus>(/^\/api\/auth\/2fa\/status$/, { enabled: false }),

  typed<typeof getPublicSettings>(/^\/api\/settings\/public$/, {}),
  typed<typeof getSettings>(/^\/api\/settings$/, {}),
  typed<typeof getSystemVersion>(/^\/api\/system\/version$/, {
    current: '0.0.0',
    latest: null,
    updateAvailable: false,
    releaseUrl: null,
    stars: null,
    checkedAt: null,
  }),
  typed<typeof listApiTokens>(/^\/api\/api-tokens$/, { tokens: [] }),

  typed<typeof getDashboardOverview>(/^\/api\/dashboard\/overview$/, {
    users: { total: 0, byStatus: {}, onlineNow: 0, onlineToday: 0, onlineThisWeek: 0, neverOnline: 0 },
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
      disk: null,
      process: { rssBytes: 0, heapUsedBytes: 0, heapLimitBytes: 0, uptimeSeconds: 0 },
    },
    nodes: [],
    byProtocol: [],
    topUsersToday: [],
    recentEvents: [],
  }),
  typed<typeof getInsights>(/^\/api\/dashboard\/insights$/, {
    windowDays: 7,
    subRequests: { total: 0, uniqueUsers: 0, byClient: [], byHourUtc: [] },
    hwid: { totalDevices: 0, usersWithDevices: 0, avgDevicesPerUser: 0, distribution: [], atOrOverLimit: 0 },
  }),

  typed<typeof listUsers>(/^\/api\/users$/, { users: [], total: 0, page: 1, limit: 25 }),
  typed<typeof listUserTags>(/^\/api\/users\/tags$/, { tags: [] }),
  none(/^\/api\/users\/[^/]+$/),
  none(/^\/api\/users\/[^/]+\/delivery$/),
  { re: /^\/api\/users\/[^/]+\/endpoints$/, reply: { endpoints: [] } },
  { re: /^\/api\/users\/[^/]+\/hwid-devices$/, reply: { devices: [] } },
  { re: /^\/api\/users\/[^/]+\/wg-devices$/, reply: { devices: [] } },

  typed<typeof listNodes>(/^\/api\/nodes$/, { nodes: [], total: 0, page: 1, limit: 25, fields: [] }),
  typed<typeof listRegions>(/^\/api\/regions$/, { regions: [] }),
  none(/^\/api\/nodes\/[^/]+$/),
  none(/^\/api\/nodes\/[^/]+\/(sync-status|exposure|conn-log|policy-drawing)$/),

  typed<typeof listProfiles>(/^\/api\/profiles$/, { profiles: [] }),
  typed<typeof listBindings>(/^\/api\/bindings$/, { bindings: [] }),
  { re: /^\/api\/bindings\/next-free-port$/, reply: { port: 443 } },
  none(/^\/api\/profiles\/[^/]+\/(host-fields|key-impact|formats|recipe)$/),

  typed<typeof listSquads>(/^\/api\/squads$/, { squads: [] }),
  typed<typeof listHosts>(/^\/api\/hosts$/, { hosts: [] }),
  none(/^\/api\/hosts\/[^/]+\/freshness$/),
  typed<typeof listCascades>(/^\/api\/cascades$/, { cascades: [], fields: [] }),
  none(/^\/api\/cascades\/[^/]+\/status$/),

  typed<typeof listAudit>(/^\/api\/audit$/, { events: [], nextCursor: null }),
  typed<typeof listSrrRules>(/^\/api\/srr$/, { rules: [] }),
  typed<typeof listTemplates>(/^\/api\/subscription-templates$/, { templates: [] }),
  typed<typeof listGeoSets>(/^\/api\/geo-sets$/, { geoSets: [] }),
  none(/^\/api\/geo-sets\/[^/]+\/(tags|rollout-plan)$/),
  typed<typeof listNamedOutbounds>(/^\/api\/named-outbounds$/, { outbounds: [] }),
  typed<typeof listRoutePolicies>(/^\/api\/route-policies$/, { policies: [] }),
  typed<typeof listRoutingPresets>(/^\/api\/routing-presets$/, { presets: [] }),
  typed<typeof getPresetNodes>(/^\/api\/routing-presets\/[^/]+\/nodes$/, { scope: 'preset', ruleCount: 0, nodes: [] }),
  typed<typeof listNodePolicies>(/^\/api\/node-policies$/, { policies: [] }),
  none(/^\/api\/node-policies\/[^/]+$/),

  typed<typeof getRecipeRegistry>(/^\/api\/recipes\/registry$/, {
    fetchedAt: '1970-01-01T00:00:00.000Z',
    source: '',
    recipes: [],
    stale: false,
    sources: [],
  }),
  typed<typeof getRecipeSources>(/^\/api\/recipes\/sources$/, { sources: [] }),
  { re: /^\/api\/settings\/subscription\/preview-url$/, reply: { url: 'https://panel.example.test/sub/preview' } },
];

export interface LoggedRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  params?: Record<string, unknown>;
  body?: unknown;
}

export interface EmptyApi {
  /** Every request in the order made, reads and writes. */
  calls: LoggedRequest[];
  /** Paths (`METHOD /path`) no fixture answered. Must stay empty. */
  unknown: string[];
  gets: (pattern?: RegExp) => LoggedRequest[];
  /** Throws, naming the paths, when the screen asked for something nobody described. */
  assertNoUnknown: () => void;
  restore: () => void;
}

export interface InstallOptions {
  routes?: RouteEntry[];
  /** Answer a write; return `undefined` to refuse it like an unlisted read. */
  onWrite?: (req: LoggedRequest) => { data: unknown } | undefined;
}

function notFoundError(url: string): AxiosError {
  const res = { status: 404, statusText: 'Not Found', data: { message: `Not found: ${url}` }, headers: {}, config: {} } as AxiosResponse;
  return new AxiosError(`Request failed with status code 404`, 'ERR_BAD_REQUEST', undefined, undefined, res);
}

export function installEmptyApi(opts: InstallOptions = {}): EmptyApi {
  const routes = [...(opts.routes ?? []), ...EMPTY_ROUTES];
  const calls: LoggedRequest[] = [];
  const unknown: string[] = [];

  const refuse = (method: string, url: string): never => {
    unknown.push(`${method} ${url}`);
    throw new Error(`emptyApi: no fixture for ${method} ${url}`);
  };

  vi.spyOn(api, 'get').mockImplementation((async (url: string, config?: { params?: Record<string, unknown> }) => {
    const params = config?.params ?? {};
    calls.push({ method: 'GET', url, params });
    const hit = routes.find((r) => r.re.test(url));
    if (!hit) return refuse('GET', url);
    const body = typeof hit.reply === 'function' ? hit.reply({ url, params }) : hit.reply;
    if (body === NOT_FOUND) throw notFoundError(url);
    return { data: body, status: 200, statusText: 'OK', headers: {}, config: {} };
  }) as unknown as typeof api.get);

  for (const [name, method] of [
    ['post', 'POST'],
    ['put', 'PUT'],
    ['patch', 'PATCH'],
    ['delete', 'DELETE'],
  ] as const) {
    vi.spyOn(api, name).mockImplementation((async (url: string, ...rest: unknown[]) => {
      const entry: LoggedRequest = { method, url, body: name === 'delete' ? undefined : rest[0] };
      calls.push(entry);
      const answer = opts.onWrite?.(entry);
      if (!answer) return refuse(method, url);
      return { data: answer.data, status: 200, statusText: 'OK', headers: {}, config: {} };
    }) as unknown as typeof api.post);
  }

  return {
    calls,
    unknown,
    gets: (pattern) => calls.filter((c) => c.method === 'GET' && (!pattern || pattern.test(c.url))),
    assertNoUnknown: () => {
      if (unknown.length) throw new Error(`emptyApi: nobody described ${[...new Set(unknown)].join(', ')}`);
    },
    restore: () => vi.restoreAllMocks(),
  };
}
