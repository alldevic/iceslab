/**
 * Sample data for the read-only demo build (VITE_DEMO_MODE). Mirrors the
 * `seed:demo` dataset so the iframe demo matches the marketing screenshots:
 * 8 nodes / 6 countries / 4 protocols, 10 users, 4 profiles, 2 squads,
 * 2 cascades. Everything is invented: *.example.com addresses (RFC 2606),
 * fictional usernames, no real endpoints or secrets. This whole file only
 * ships in the demo build.
 *
 * Shapes are taken from the typed helpers in ../lib/api.ts.
 */
import type {
  AdminSettings,
  AuthStatusResponse,
  Binding,
  Cascade,
  DashboardOverview,
  Host,
  HwidDevice,
  Insights,
  Node as PanelNode,
  Profile,
  PublicSettings,
  Region,
  RoutePolicy,
  Squad,
  SystemVersion,
  User,
  UserEndpoint,
} from '../lib/api';
import { DEMO_NOW } from '../lib/demoFlag';

const GiB = 1024 ** 3;
// Anchor every relative timestamp to the same frozen "now" the UI reads via
// now() (lib/demoFlag), so the demo never drifts out of sync.
const BASE = DEMO_NOW;
const iso = (msAgo: number): string => new Date(BASE - msAgo).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// ───── Regions ─────

export const REGIONS: Region[] = [
  { id: 'reg-eu', name: 'Europe', code: 'EU', nodeCount: 5, createdAt: iso(60 * DAY), updatedAt: iso(60 * DAY) },
  { id: 'reg-us', name: 'North America', code: 'US', nodeCount: 1, createdAt: iso(60 * DAY), updatedAt: iso(60 * DAY) },
  { id: 'reg-as', name: 'Asia', code: 'AS', nodeCount: 1, createdAt: iso(60 * DAY), updatedAt: iso(60 * DAY) },
  { id: 'reg-ru', name: 'RU TSPU-zone', code: 'RU', nodeCount: 1, createdAt: iso(60 * DAY), updatedAt: iso(60 * DAY) },
];

// ───── Nodes ─────

interface NodeSeed {
  id: string;
  name: string;
  host: string;
  cc: string;
  protocol: PanelNode['protocol'];
  region: string;
  selfSteal?: boolean;
  cpu: number;
  ram: number;
  disk: number;
  cores: number;
  ramGiB: number;
  diskGiB: number;
  todayGiB: number;
}

const NODE_SEEDS: NodeSeed[] = [
  { id: 'node-awg-ru-01', name: 'awg-ru-01', host: 'ru-01.example.com', cc: 'RU', protocol: 'amneziawg', region: 'reg-ru', cpu: 34, ram: 50, disk: 40, cores: 2, ramGiB: 4, diskGiB: 40, todayGiB: 12.9 },
  { id: 'node-awg-se-01', name: 'awg-se-01', host: 'se-01.example.com', cc: 'SE', protocol: 'amneziawg', region: 'reg-eu', cpu: 31, ram: 49, disk: 41, cores: 2, ramGiB: 4, diskGiB: 40, todayGiB: 16.2 },
  { id: 'node-hy2-nl-01', name: 'hy2-nl-01', host: 'nl-01.example.com', cc: 'NL', protocol: 'hysteria', region: 'reg-eu', cpu: 92, ram: 93, disk: 81, cores: 4, ramGiB: 8, diskGiB: 80, todayGiB: 30.5 },
  { id: 'node-hy2-sg-01', name: 'hy2-sg-01', host: 'sg-01.example.com', cc: 'SG', protocol: 'hysteria', region: 'reg-as', cpu: 84, ram: 89, disk: 81, cores: 2, ramGiB: 4, diskGiB: 40, todayGiB: 23.2 },
  { id: 'node-ss-fi-01', name: 'ss-fi-01', host: 'fi-01.example.com', cc: 'FI', protocol: 'shadowsocks', region: 'reg-eu', cpu: 19, ram: 36, disk: 25, cores: 2, ramGiB: 2, diskGiB: 20, todayGiB: 10.8 },
  { id: 'node-xray-de-01', name: 'xray-de-01', host: 'de-01.example.com', cc: 'DE', protocol: 'xray', region: 'reg-eu', selfSteal: true, cpu: 14, ram: 33, disk: 24, cores: 8, ramGiB: 16, diskGiB: 160, todayGiB: 36.8 },
  { id: 'node-xray-de-02', name: 'xray-de-02', host: 'de-02.example.com', cc: 'DE', protocol: 'xray', region: 'reg-eu', selfSteal: true, cpu: 51, ram: 72, disk: 56, cores: 4, ramGiB: 8, diskGiB: 80, todayGiB: 24.1 },
  { id: 'node-xray-us-01', name: 'xray-us-01', host: 'us-01.example.com', cc: 'US', protocol: 'xray', region: 'reg-us', selfSteal: true, cpu: 53, ram: 68, disk: 56, cores: 4, ramGiB: 8, diskGiB: 80, todayGiB: 38.2 },
];

// Restart tallies for the demo fleet. Only xray reports one, and the three
// xray nodes deliberately show the three states the card has to tell apart: a
// core that never blinked, a core the memory watchdog has been bouncing, and a
// node that never reported at all (null, which is NOT zero restarts).
const CORE_RESTARTS: Record<string, PanelNode['coreRestarts']> = {
  'node-xray-de-01': {
    total: 0,
    crash: 0,
    memory: 0,
    memoryLimitBytes: 2 * GiB,
    rssBytes: Math.round(0.42 * GiB),
    observedAt: iso(4 * 60_000),
  },
  'node-xray-de-02': {
    total: 3,
    crash: 0,
    memory: 3,
    lastAt: iso(5 * HOUR),
    lastReason: 'memory',
    memoryLimitBytes: GiB,
    rssBytes: Math.round(0.79 * GiB),
    observedAt: iso(2 * 60_000),
  },
};

export const NODES: PanelNode[] = NODE_SEEDS.map((n) => ({
  id: n.id,
  name: n.name,
  address: `${n.host}:1337`,
  protocol: n.protocol,
  countryCode: n.cc,
  status: 'online',
  lastStatusChange: iso(3 * HOUR),
  lastStatusMessage: null,
  coreRestarts: CORE_RESTARTS[n.id] ?? null,
  coreVersion: n.protocol === 'xray' ? '26.3.27' : null,
  consumptionMultiplier: '1',
  regionId: n.region,
  maxUsers: 1000,
  domain: n.selfSteal ? n.host : null,
  hardening: n.selfSteal ? { ufwLockdown: true, fail2ban: true, realisticFallback: true } : null,
  warpEnabled: false,
  singboxEngine: false,
  createdAt: iso(50 * DAY),
  updatedAt: iso(3 * HOUR),
}));

export const NODES_LIST = { nodes: NODES, total: NODES.length, page: 1, limit: 25 };

// ───── Profiles + Bindings ─────

const PROFILE_SEEDS: Array<{ id: string; name: string; protocol: Profile['protocol']; bindings: number; users: number }> = [
  { id: 'prof-vless-reality', name: 'vless-reality', protocol: 'xray', bindings: 3, users: 10 },
  { id: 'prof-hy2', name: 'hy2', protocol: 'hysteria', bindings: 2, users: 10 },
  { id: 'prof-awg', name: 'awg', protocol: 'amneziawg', bindings: 2, users: 5 },
  { id: 'prof-ss2022', name: 'ss2022', protocol: 'shadowsocks', bindings: 1, users: 10 },
];

export const PROFILES: Profile[] = PROFILE_SEEDS.map((p) => ({
  id: p.id,
  name: p.name,
  protocol: p.protocol,
  engine: null,
  description: `Demo ${p.name} profile`,
  // Config kept minimal - the demo never renders raw protocol config in lists.
  config: {} as Profile['config'],
  enabled: true,
  bindingCount: p.bindings,
  userCount: p.users,
  createdAt: iso(50 * DAY),
  updatedAt: iso(5 * DAY),
}));

// One binding per node, wiring each node to its protocol's profile.
const PROFILE_BY_PROTOCOL: Record<string, string> = {
  xray: 'prof-vless-reality',
  hysteria: 'prof-hy2',
  amneziawg: 'prof-awg',
  shadowsocks: 'prof-ss2022',
};
const PORT_BY_PROTOCOL: Record<string, number> = {
  xray: 443,
  hysteria: 443,
  amneziawg: 51820,
  shadowsocks: 8388,
};

export const BINDINGS: Binding[] = NODE_SEEDS.map((n, i) => ({
  id: `bind-${i}`,
  profileId: PROFILE_BY_PROTOCOL[n.protocol]!,
  nodeId: n.id,
  port: PORT_BY_PROTOCOL[n.protocol]!,
  publicHost: n.host,
  publicPort: PORT_BY_PROTOCOL[n.protocol]!,
  overrides: null,
  enabled: true,
  createdAt: iso(50 * DAY),
  updatedAt: iso(5 * DAY),
}));

/**
 * One host per binding: the demo needs them for the Hosts page and for the
 * squad editor's country tree, both of which read hosts rather than bindings.
 * The remark is what a member sees in their client, so it reads like a place,
 * not like an id.
 */
export const HOSTS: Host[] = NODE_SEEDS.map((n, i) => ({
  id: `host-${i}`,
  bindingId: `bind-${i}`,
  remark: n.name,
  priority: i,
  // One host is off, so the states that depend on it have something to show:
  // it sits in the squad tree at half strength and counts for nothing, because
  // the subscription builder only reads enabled hosts.
  enabled: n.id !== 'node-ss-fi-01',
  addressOverride: null,
  portOverride: null,
  sniOverride: null,
  hostHeaderOverride: null,
  pathOverride: null,
  fingerprintOverride: null,
  alpn: [],
  allowInsecure: false,
  securityLayer: 'default',
  disableForFormats: [],
  createdAt: iso(50 * DAY),
  updatedAt: iso(5 * DAY),
}));

// ───── Squads ─────

export const SQUADS: Squad[] = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'default',
    description: 'Standard squad',
    profileIds: ['prof-vless-reality', 'prof-hy2', 'prof-ss2022'],
    routingPreset: null,
    exitAcl: [],
    policyIds: [],
    hostIds: [],
    hwidDeviceLimit: null,
    memberCount: 7,
    createdAt: iso(50 * DAY),
    updatedAt: iso(5 * DAY),
  },
  // A paid tier: fewer protocols than premium, and its exits are restricted to
  // one, so the card shows the "1 of N" state.
  {
    id: 'squad-basic',
    name: 'basic',
    description: 'Paid tier, RU entry plus one EU exit',
    profileIds: ['prof-vless-reality', 'prof-hy2'],
    routingPreset: null,
    exitAcl: [{ cascadeId: 'casc-us-relay', exitNodeIds: ['node-xray-de-01'] }],
    policyIds: ['policy-no-ads'],
    // A tier that sees two of its profiles' hosts, so the restricted mode of the
    // squad screen has something to show.
    hostIds: ['host-5', 'host-2'],
    hwidDeviceLimit: 3,
    memberCount: 12,
    createdAt: iso(40 * DAY),
    updatedAt: iso(3 * DAY),
  },
  {
    id: 'squad-premium',
    name: 'premium',
    description: 'Every protocol, every exit, no policy limits',
    profileIds: ['prof-vless-reality', 'prof-hy2', 'prof-ss2022', 'prof-awg'],
    routingPreset: null,
    exitAcl: [],
    policyIds: [],
    hostIds: [],
    hwidDeviceLimit: 5,
    memberCount: 5,
    createdAt: iso(50 * DAY),
    updatedAt: iso(5 * DAY),
  },
  // Nothing granted yet: the one broken state the list is meant to surface.
  {
    id: 'squad-reseller',
    name: 'reseller',
    description: 'Partner accounts, no hosts granted yet',
    profileIds: [],
    routingPreset: null,
    exitAcl: [],
    policyIds: [],
    hostIds: [],
    hwidDeviceLimit: null,
    memberCount: 3,
    createdAt: iso(12 * DAY),
    updatedAt: iso(1 * DAY),
  },
];

// ───── Users ─────

interface UserSeed {
  id: string;
  name: string;
  status: string;
  squads: string[];
  usedGiB: number;
  limitGiB: number | null;
  expDays: number;
  onlineMin: number | null;
  premium: boolean;
}
const USER_SEEDS: UserSeed[] = [
  { id: 'user-alex', name: 'alex', status: 'active', squads: ['00000000-0000-0000-0000-000000000001', 'squad-premium'], usedGiB: 118, limitGiB: 200, expDays: 35, onlineMin: 0, premium: true },
  { id: 'user-mia', name: 'mia', status: 'active', squads: ['squad-premium'], usedGiB: 96, limitGiB: 200, expDays: 28, onlineMin: 1, premium: true },
  { id: 'user-kenji', name: 'kenji', status: 'active', squads: ['00000000-0000-0000-0000-000000000001', 'squad-premium'], usedGiB: 140, limitGiB: null, expDays: 40, onlineMin: 1, premium: true },
  { id: 'user-sofia', name: 'sofia', status: 'active', squads: ['squad-premium'], usedGiB: 70, limitGiB: 150, expDays: 22, onlineMin: 2, premium: true },
  { id: 'user-liam', name: 'liam', status: 'active', squads: ['00000000-0000-0000-0000-000000000001'], usedGiB: 41, limitGiB: 100, expDays: 18, onlineMin: 2, premium: false },
  // Away for an hour and a half: a working subscription that is simply not
  // connected right now, which is the only way the OFFLINE pill shows up. The
  // expired and disabled seeds below cannot stand in for it, their own state
  // wins over presence.
  { id: 'user-nadia', name: 'nadia', status: 'active', squads: ['00000000-0000-0000-0000-000000000001'], usedGiB: 33, limitGiB: 100, expDays: 30, onlineMin: 92, premium: false },
  { id: 'user-diego', name: 'diego', status: 'active', squads: ['00000000-0000-0000-0000-000000000001'], usedGiB: 88, limitGiB: null, expDays: 12, onlineMin: 1, premium: false },
  { id: 'user-omar', name: 'omar', status: 'limited', squads: ['00000000-0000-0000-0000-000000000001'], usedGiB: 52, limitGiB: 50, expDays: 25, onlineMin: 1, premium: false },
  { id: 'user-yuki', name: 'yuki', status: 'expired', squads: ['00000000-0000-0000-0000-000000000001'], usedGiB: 64, limitGiB: 100, expDays: -3, onlineMin: 300, premium: false },
  { id: 'user-elena', name: 'elena', status: 'disabled', squads: ['squad-premium'], usedGiB: 12, limitGiB: 100, expDays: 60, onlineMin: 1800, premium: true },
];

export const USERS: User[] = USER_SEEDS.map((u, i) => ({
  id: u.id,
  shortId: `u${(i + 1).toString().padStart(2, '0')}demo`,
  username: u.name,
  status: u.status,
  expireAt: iso(-u.expDays * DAY),
  trafficLimitBytes: u.limitGiB === null ? null : Math.round(u.limitGiB * GiB),
  trafficUsedBytes: Math.round(u.usedGiB * GiB),
  lifetimeTrafficBytes: Math.round(u.usedGiB * 2.4 * GiB),
  trafficLimitStrategy: 'no_reset',
  lastTrafficResetAt: null,
  lastOnlineAt: u.onlineMin === null ? null : iso(u.onlineMin * 60_000),
  subscriptionToken: `demo-sub-${u.name}`,
  subRevokedAt: null,
  hwidDeviceLimit: u.premium ? 5 : null,
  // One user carries a per-user override, so the list chip and the routing
  // filter have something to show. The rest inherit from squad or panel.
  routingPreset: u.name === 'kenji' ? 'ru-split' : null,
  description: null,
  tag: u.premium ? 'premium' : 'standard',
  telegramId: null,
  email: null,
  enabledProtocols: u.premium
    ? ['xray', 'hysteria', 'shadowsocks', 'amneziawg']
    : ['xray', 'hysteria', 'shadowsocks'],
  groupIds: u.squads,
  createdAt: iso((40 - i) * DAY),
  updatedAt: iso(u.onlineMin === null ? 5 * DAY : u.onlineMin * 60_000),
}));

export const USERS_LIST = { users: USERS, total: USERS.length, page: 1, limit: 25 };

/**
 * What a user's client would actually receive.
 *
 * Written out rather than derived, on purpose: the panel stopped recomputing
 * the subscription in the browser precisely because that recomputation kept
 * disagreeing with the real one. The demo would repeat the same mistake with
 * the same result. So these are fixed answers in the shape the endpoint
 * returns, and they show the two things a binding count can never show: a
 * cascade entry fanning out into one line per direction and per policy, and
 * exits that never reach the client as their own line.
 */
const DEMO_URI = 'vless://demo-uri-not-a-real-key';
// The first three ride one entry node: that is the point of the fixture, a
// count of nodes and a count of configs must be free to disagree.
const PREMIUM_ENDPOINTS: UserEndpoint[] = [
  { protocol: 'xray', label: 'US · us-01', nodeId: 'node-xray-us-01', host: 'us-01.example.com', port: 443, uri: DEMO_URI },
  { protocol: 'xray', label: 'DE', nodeId: 'node-xray-us-01', host: 'us-01.example.com', port: 443, uri: DEMO_URI },
  { protocol: 'xray', label: 'DE · Без рекламы', nodeId: 'node-xray-us-01', host: 'us-01.example.com', port: 443, uri: DEMO_URI },
  { protocol: 'hysteria', label: 'NL · nl-01', nodeId: 'node-hy2-nl-01', host: 'nl-01.example.com', port: 8443, uri: DEMO_URI },
  { protocol: 'shadowsocks', label: 'FI · fi-01', nodeId: 'node-ss-fi-01', host: 'fi-01.example.com', port: 8388, uri: DEMO_URI },
  { protocol: 'amneziawg', label: 'SE · se-01', nodeId: 'node-awg-se-01', host: 'se-01.example.com', port: 51820, uri: DEMO_URI },
];
const STANDARD_ENDPOINTS: UserEndpoint[] = [
  { protocol: 'xray', label: 'DE · de-02', nodeId: 'node-xray-de-02', host: 'de-02.example.com', port: 443, uri: DEMO_URI },
  { protocol: 'hysteria', label: 'SG · sg-01', nodeId: 'node-hy2-sg-01', host: 'sg-01.example.com', port: 8443, uri: DEMO_URI },
];

export function endpointsFor(userId: string): UserEndpoint[] {
  const user = USERS.find((u) => u.id === userId);
  if (!user) return [];
  return user.groupIds.includes('squad-premium') ? PREMIUM_ENDPOINTS : STANDARD_ENDPOINTS;
}

/**
 * HWID slots in use. alex sits at his limit so the "every slot is taken" line
 * has something to appear next to, and one device carries no label, which is
 * the ordinary case: a label is only there if a client sent one.
 */
export const HWID_DEVICES: Record<string, HwidDevice[]> = {
  'user-alex': [
    { id: 'dev-1', userId: 'user-alex', hwid: 'a4f1c8e2b90d47ac9f3e', label: 'MacBook Pro', firstSeenAt: iso(30 * DAY), lastSeenAt: iso(4 * 60_000) },
    { id: 'dev-2', userId: 'user-alex', hwid: '77b2d091fe3a4c58ab61', label: 'iPhone 15', firstSeenAt: iso(21 * DAY), lastSeenAt: iso(2 * HOUR) },
    { id: 'dev-3', userId: 'user-alex', hwid: 'c93e5a17d84b26f0cc42', label: null, firstSeenAt: iso(9 * DAY), lastSeenAt: iso(3 * DAY) },
    { id: 'dev-4', userId: 'user-alex', hwid: '5d81aa3c6e97b420f1d8', label: 'Windows-PC', firstSeenAt: iso(6 * DAY), lastSeenAt: iso(11 * HOUR) },
    { id: 'dev-5', userId: 'user-alex', hwid: 'e0c4b7529d1af86b3a70', label: 'iPad', firstSeenAt: iso(2 * DAY), lastSeenAt: iso(26 * HOUR) },
  ],
  'user-mia': [
    { id: 'dev-6', userId: 'user-mia', hwid: '1f9d6b34ca82e57d0b93', label: 'Pixel 8', firstSeenAt: iso(12 * DAY), lastSeenAt: iso(9 * 60_000) },
  ],
};

// ───── Cascades (xray -> xray only, the realised cell) ─────

export const CASCADES: Cascade[] = [
  {
    id: 'casc-ru-exit-bypass',
    name: 'ru-exit-bypass',
    enabled: true,
    mode: 'chain',
    hideHopsFromSub: true,
    hops: [
      { id: 'hop-ru-0', nodeId: 'node-xray-de-01', nodeName: 'xray-de-01', position: 0, entryProtocol: 'xray', linkProtocol: 'vless' },
      { id: 'hop-ru-1', nodeId: 'node-xray-de-02', nodeName: 'xray-de-02', position: 1, entryProtocol: null, linkProtocol: null },
    ],
    // v4: one entry, one way out. The demo carries both shapes so the screens
    // render off `directions`, the way a live panel does.
    positions: [
      { position: 0, nodeIds: ['node-xray-de-01'], entryProtocol: 'xray', linkProtocol: 'vless' },
    ],
    directions: [
      { id: 'dir-ru-de', tag: 1, countryCode: 'DE', nodeIds: ['node-xray-de-02'] },
    ],
    nextDirectionTag: 2,
    createdAt: iso(20 * DAY),
    updatedAt: iso(2 * DAY),
  },
  {
    id: 'casc-us-relay',
    name: 'us-eu-relay',
    enabled: true,
    mode: 'balancer',
    hideHopsFromSub: false,
    hops: [
      { id: 'hop-us-0', nodeId: 'node-xray-us-01', nodeName: 'xray-us-01', position: 0, entryProtocol: 'xray', linkProtocol: 'vless' },
      { id: 'hop-us-1', nodeId: 'node-xray-de-01', nodeName: 'xray-de-01', position: 1, entryProtocol: null, linkProtocol: null },
    ],
    positions: [
      { position: 0, nodeIds: ['node-xray-us-01'], entryProtocol: 'xray', linkProtocol: 'vless' },
    ],
    // Tag 3 with only two directions on file is the point: tag 2 was spent by a
    // direction that has since been deleted, and it never comes back.
    directions: [
      { id: 'dir-us-de', tag: 1, countryCode: 'DE', nodeIds: ['node-xray-de-01'] },
      { id: 'dir-us-se', tag: 3, countryCode: 'SE', nodeIds: [] },
    ],
    nextDirectionTag: 4,
    createdAt: iso(18 * DAY),
    updatedAt: iso(2 * DAY),
  },
];

// ───── Route policies (A4 ad-split) ─────

export const ROUTE_POLICIES: RoutePolicy[] = [
  {
    id: 'policy-no-ads',
    name: 'Без рекламы',
    ordinal: 1,
    directDomains: [],
    blockDomains: Array.from({ length: 412 }, (_, i) => `ads-${i}.example`),
  },
  {
    id: 'policy-ru-direct',
    name: 'RU direct',
    ordinal: 2,
    directDomains: Array.from({ length: 1800 }, (_, i) => `ru-${i}.example`),
    blockDomains: [],
  },
];

// ───── Settings / auth / version / insights ─────

export const PUBLIC_SETTINGS: PublicSettings = { brandName: 'Iceslab' };

export const SETTINGS: AdminSettings = {
  brandName: 'Iceslab',
  subscriptionProfileTitle: 'Iceslab',
  subscriptionUpdateIntervalHours: 12,
  subscriptionSupportUrl: 'https://t.me/example',
  subscriptionAnnounceTemplate: null,
  subscriptionRoutingPreset: 'proxy-all',
  subscriptionTlsFragment: false,
  subscriptionCustomRoutingRules: null,
  subscriptionCustomDomainLists: null,
};

export const AUTH_STATUS: AuthStatusResponse = {
  authentication: { password: { enabled: true } },
  registration: { enabled: false },
  panel: { publicUrl: 'https://panel.example.com', subscriptionPathPrefix: '/sub' },
};

export const VERSION: SystemVersion = {
  current: '0.1.9',
  latest: '0.1.9',
  updateAvailable: false,
  releaseUrl: null,
  stars: 19,
  checkedAt: iso(2 * HOUR),
};

export const INSIGHTS: Insights = {
  windowDays: 7,
  subRequests: {
    total: 1284,
    uniqueUsers: 9,
    byClient: [
      { client: 'Hiddify', count: 540 },
      { client: 'v2rayNG', count: 312 },
      { client: 'streisand', count: 188 },
      { client: 'Clash Meta', count: 144 },
      { client: 'sing-box', count: 100 },
    ],
    byHourUtc: Array.from({ length: 24 }, (_, h) => 20 + Math.round(40 * Math.max(0, Math.sin(((h - 6) / 24) * 2 * Math.PI)))),
  },
  hwid: {
    totalDevices: 23,
    usersWithDevices: 9,
    avgDevicesPerUser: 2.6,
    distribution: [
      { bucket: '1', users: 3 },
      { bucket: '2', users: 3 },
      { bucket: '3', users: 2 },
      { bucket: '4+', users: 1 },
    ],
    atOrOverLimit: 1,
  },
};

// ───── Dashboard overview (the one rich endpoint) ─────

export function buildOverview(): DashboardOverview {
  return {
    users: {
      total: 10,
      byStatus: { active: 7, limited: 1, expired: 1, disabled: 1 },
      // Counted off the seeds above, not made up: seven users inside the
      // five-minute window. The list would contradict this card otherwise, and
      // that disagreement is exactly what the shared window was extracted for.
      onlineNow: 7,
      onlineToday: 9,
      onlineThisWeek: 10,
      neverOnline: 0,
    },
    traffic: {
      todayBytes: Math.round(193 * GiB),
      yesterdayBytes: Math.round(1.74 * 1024 * GiB),
      last7dBytes: Math.round(4.49 * 1024 * GiB),
      last30dBytes: Math.round(9.17 * 1024 * GiB),
      calendarMonthBytes: Math.round(6.75 * 1024 * GiB),
      currentYearBytes: Math.round(13.2 * 1024 * GiB),
      prev7dBytes: Math.round(1.44 * 1024 * GiB),
      prev30dBytes: Math.round(4.07 * 1024 * GiB),
      lastCalendarMonthBytes: Math.round(6.43 * 1024 * GiB),
      lastYearBytes: 0,
      last24hHourly: Array.from({ length: 24 }, (_, i) => {
        const h = 23 - i;
        const hod = new Date(BASE - h * HOUR).getUTCHours();
        const shape = 0.4 + 0.6 * (0.5 - 0.5 * Math.cos(((hod - 6) / 24) * 2 * Math.PI));
        return { hour: new Date(BASE - h * HOUR).toISOString(), bytes: Math.round(shape * 9 * GiB) };
      }),
    },
    system: { onlineNodeCount: 8, totalNodeCount: 8 },
    // Counts feed the sidebar badges, so they have to agree with the lists
    // above or the demo contradicts itself on screen.
    inventory: { profileCount: PROFILES.length, squadCount: SQUADS.length, hostCount: HOSTS.length },
    host: {
      cpu: { loadPercent: 4, samplePercent: 4, cores: 6, loadavg: [0.23, 0.34, 0.4] },
      memory: { totalBytes: Math.round(11.6 * GiB), usedBytes: Math.round(1.84 * GiB), usedPercent: 15.8 },
      disk: { totalBytes: Math.round(930 * GiB), usedBytes: Math.round(403 * GiB), usedPercent: 43.3, path: '/' },
      process: { rssBytes: Math.round(0.27 * GiB), heapUsedBytes: Math.round(0.07 * GiB), heapLimitBytes: Math.round(2.05 * GiB), uptimeSeconds: 811 },
    },
    nodes: NODE_SEEDS.map((n) => ({
      id: n.id,
      name: n.name,
      address: `${n.host}:1337`,
      protocol: n.protocol,
      status: 'online',
      countryCode: n.cc,
      lastStatusChange: iso(3 * HOUR),
      inboundCount: 1,
      todayBytes: Math.round(n.todayGiB * GiB),
      metrics: {
        cpu: { usagePercent: n.cpu, loadAvg1: Number(((n.cpu / 100) * n.cores).toFixed(2)), loadAvg5: Number(((n.cpu / 100) * n.cores * 0.85).toFixed(2)), loadAvg15: Number(((n.cpu / 100) * n.cores * 0.7).toFixed(2)), cores: n.cores },
        memory: { totalBytes: n.ramGiB * GiB, availableBytes: Math.round((1 - n.ram / 100) * n.ramGiB * GiB), usedBytes: Math.round((n.ram / 100) * n.ramGiB * GiB), usedPercent: n.ram },
        disk: { path: '/', totalBytes: n.diskGiB * GiB, usedBytes: Math.round((n.disk / 100) * n.diskGiB * GiB), usedPercent: n.disk },
        uptimeSeconds: 3 * 24 * 3600,
        collectedAt: iso(10_000),
      },
    })),
    byProtocol: [
      { protocol: 'xray', inboundCount: 1, enabledUserCount: 10 },
      { protocol: 'hysteria', inboundCount: 1, enabledUserCount: 10 },
      { protocol: 'shadowsocks', inboundCount: 1, enabledUserCount: 10 },
      { protocol: 'amneziawg', inboundCount: 1, enabledUserCount: 5 },
    ],
    topUsersToday: [
      { id: 'user-alex', username: 'alex', bytes: Math.round(14 * GiB) },
      { id: 'user-mia', username: 'mia', bytes: Math.round(11 * GiB) },
      { id: 'user-kenji', username: 'kenji', bytes: Math.round(9 * GiB) },
      { id: 'user-sofia', username: 'sofia', bytes: Math.round(7 * GiB) },
      { id: 'user-diego', username: 'diego', bytes: Math.round(5 * GiB) },
    ],
    recentEvents: [
      { id: 'ev-1', eventType: 'user_created', userId: 'user-diego', username: 'diego', createdAt: iso(2 * HOUR) },
      { id: 'ev-2', eventType: 'traffic_reset', userId: 'user-kenji', username: 'kenji', createdAt: iso(3 * HOUR) },
      { id: 'ev-3', eventType: 'disabled', userId: 'user-elena', username: 'elena', createdAt: iso(4 * HOUR) },
      { id: 'ev-4', eventType: 'expire_extended', userId: 'user-sofia', username: 'sofia', createdAt: iso(6 * HOUR) },
      { id: 'ev-5', eventType: 'limited', userId: 'user-omar', username: 'omar', createdAt: iso(9 * HOUR) },
      { id: 'ev-6', eventType: 'expired', userId: 'user-yuki', username: 'yuki', createdAt: iso(14 * HOUR) },
    ],
  };
}
