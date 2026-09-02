import type {
  Binding,
  Cascade,
  Host,
  HwidDevice,
  Node,
  Profile,
  Region,
  RoutePolicy,
  RoutingPreset,
  Squad,
  User,
} from '../lib/api';

/**
 * One well-formed record of each kind the screens are handed.
 *
 * A screen test needs a record before it can assert anything, and every file
 * that wanted one wrote its own — twenty-odd lines of literal per type, each
 * free to omit a field the component reads. An omission does not fail the
 * fixture, it makes the component render a blank and the test call that a pass.
 *
 * So these are held to `lib/api.ts` by `records.mirror.test.ts`: every required
 * member present, none invented. What the VALUES are is a fixture's own
 * business — what the SHAPE is is the API's.
 *
 * Each factory takes an override so a case can say the one field it is about
 * and nothing else, which is the point of a fixture: the case reads as the
 * difference from ordinary.
 */

const AT = '2026-08-01T00:00:00.000Z';

export function aNode(over: Partial<Node> = {}): Node {
  return {
    id: 'node-1',
    name: 'ams-1',
    address: '203.0.113.10:1337',
    protocol: 'xray' as Node['protocol'],
    countryCode: 'NL',
    status: 'online',
    lastStatusChange: AT,
    lastStatusMessage: null,
    coreRestarts: null,
    coreVersion: '26.3.27',
    consumptionMultiplier: '1',
    regionId: null,
    maxUsers: null,
    domain: null,
    warpEnabled: false,
    singboxEngine: false,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

export function aProfile(over: Partial<Profile> = {}): Profile {
  return {
    id: 'profile-1',
    name: 'vless-reality',
    protocol: 'vless' as Profile['protocol'],
    engine: null,
    description: null,
    config: {} as Profile['config'],
    enabled: true,
    bindingCount: 0,
    userCount: 0,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

export function aBinding(over: Partial<Binding> = {}): Binding {
  return {
    id: 'binding-1',
    profileId: 'profile-1',
    nodeId: 'node-1',
    port: 443,
    publicHost: null,
    publicPort: null,
    overrides: null,
    enabled: true,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

export function aHost(over: Partial<Host> = {}): Host {
  return {
    id: 'host-1',
    bindingId: 'binding-1',
    remark: 'Amsterdam',
    priority: 0,
    enabled: true,
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
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

export function aSquad(over: Partial<Squad> = {}): Squad {
  return {
    id: 'squad-1',
    name: 'Standard',
    description: null,
    profileIds: [],
    exitAcl: [],
    policyIds: [],
    hostIds: [],
    routingPreset: null,
    hwidDeviceLimit: null,
    memberCount: 0,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

export function aUser(over: Partial<User> = {}): User {
  return {
    id: 'user-1',
    shortId: 'ab12cd34',
    username: 'buyer',
    status: 'active',
    expireAt: null,
    trafficLimitBytes: null,
    trafficUsedBytes: 0,
    lifetimeTrafficBytes: 0,
    // Lowercase, as the API returns it and as `TrafficLimitStrategy` declares
    // it. It was `'NO_RESET' as User['trafficLimitStrategy']`, and the cast is
    // what let it through: every screen mounted with this fixture was reading a
    // shape no response has, and the edit-form round-trip is where that came
    // out - the drawer sent the fixture's value straight back and the API's own
    // schema refused it.
    trafficLimitStrategy: 'no_reset',
    lastTrafficResetAt: null,
    lastOnlineAt: null,
    subscriptionToken: 'tok-buyer',
    subRevokedAt: null,
    hwidDeviceLimit: null,
    routingPreset: null,
    description: null,
    tag: null,
    telegramId: null,
    email: null,
    enabledProtocols: [],
    groupIds: [],
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

export function aCascade(over: Partial<Cascade> = {}): Cascade {
  return {
    id: 'cascade-1',
    name: 'ru-exit',
    enabled: true,
    mode: 'chain' as Cascade['mode'],
    hideHopsFromSub: true,
    autoProfile: false,
    autoLabel: null,
    autoLineLabel: '⚡ ru-exit → Auto',
    hops: [],
    positions: [],
    directions: [],
    nextDirectionTag: 1,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

export function aRoutePolicy(over: Partial<RoutePolicy> = {}): RoutePolicy {
  return {
    id: 'policy-1',
    name: 'ads-off',
    ordinal: 1,
    directDomains: [],
    blockDomains: ['geosite:category-ads-all'],
    ...over,
  };
}

export function aRoutingPreset(over: Partial<RoutingPreset> = {}): RoutingPreset {
  return {
    id: 'preset-1',
    name: 'Plain',
    builtIn: true,
    rules: [],
    ...over,
  };
}

export function aRegion(over: Partial<Region> = {}): Region {
  return {
    id: 'region-1',
    name: 'Europe',
    code: 'eu',
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

export function aDevice(over: Partial<HwidDevice> = {}): HwidDevice {
  return {
    id: 'device-1',
    userId: 'user-1',
    hwid: 'HWID-0001',
    label: null,
    firstSeenAt: AT,
    lastSeenAt: AT,
    ...over,
  };
}
