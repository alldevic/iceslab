import type { GeoSet } from '@/lib/domain/geoSets';
import type { InboundConfig } from '@/lib/domain/inbounds';
import type { NodePolicy } from '@/lib/domain/nodePolicies';
import type { Profile } from '@/lib/domain/profiles';
import type { RoutePolicy, RoutingPreset } from '@/lib/domain/routePolicies';
import type { User } from '@/lib/domain/users';

/**
 * The smallest record each component that cannot open without one will take.
 * Typed by the interfaces of `lib/domain`, so a required field added there
 * fails `tsc` here. Empty everywhere the type allows it: a modal that only
 * works on a rich record is a modal the "empty panel" case never reaches.
 */

const T0 = '1970-01-01T00:00:00.000Z';

export const profileRecord = (over: Partial<Profile> = {}): Profile => ({
  id: 'p1',
  name: 'min-profile',
  protocol: 'xray',
  engine: null,
  effectiveEngine: 'xray',
  description: null,
  // Only the keys the form reads on a first render; the rest of the union
  // member is the form's own defaults.
  config: { subprotocol: 'vless', security: 'reality', network: 'raw' } as unknown as InboundConfig,
  enabled: true,
  bindingCount: 0,
  userCount: 0,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

export const userRecord = (over: Partial<User> = {}): User => ({
  id: 'u1',
  shortId: 'u1',
  username: 'min-user',
  status: 'active',
  expireAt: null,
  trafficLimitBytes: null,
  trafficUsedBytes: 0,
  lifetimeTrafficBytes: 0,
  trafficLimitStrategy: 'no_reset',
  lastTrafficResetAt: null,
  lastOnlineAt: null,
  firstConnectedAt: null,
  lastConnectedNodeId: null,
  lastConnectedNodeName: null,
  subscriptionToken: 'tok',
  subRevokedAt: null,
  hwidDeviceLimit: null,
  routingPreset: null,
  description: null,
  tag: null,
  telegramId: null,
  email: null,
  enabledProtocols: [],
  groupIds: [],
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

export const geoSetRecord = (over: Partial<GeoSet> = {}): GeoSet => ({
  id: 'g1',
  name: 'min-set',
  kind: 'geosite',
  source: { type: 'url', url: 'https://example.test/geosite.dat', sha256Source: 'manual', refreshHours: 24 } as GeoSet['source'],
  format: 'dat' as GeoSet['format'],
  status: 'ok' as GeoSet['status'],
  checkedAt: null,
  error: null,
  current: null,
  usedByRules: 0,
  nodes: { total: 0, behind: 0 },
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

export const routePolicyRecord = (over: Partial<RoutePolicy> = {}): RoutePolicy => ({
  id: 'rp1',
  name: 'min-policy',
  ordinal: 1,
  directDomains: [],
  blockDomains: [],
  ...over,
});

export const routingPresetRecord = (over: Partial<RoutingPreset> = {}): RoutingPreset => ({
  id: 'preset1',
  name: 'min-preset',
  builtIn: false,
  rules: [],
  ...over,
});

export const nodePolicyRecord = (over: Partial<NodePolicy> = {}): NodePolicy => ({
  id: 'np1',
  name: 'min-node-policy',
  description: null,
  rules: [],
  createdAt: T0,
  updatedAt: T0,
  ...over,
});
