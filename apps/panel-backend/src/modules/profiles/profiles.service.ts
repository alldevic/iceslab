import type { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { eventBus } from '../../lib/event-bus.js';
import { prisma } from '../../prisma.js';
import { ALL_SQUAD_ID } from '../squads/squads.constants.js';
import {
  PROTOCOL_CONFIG_SCHEMAS,
} from '../inbounds/inbounds.schemas.js';
import { ensureDefaultHost } from '../hosts/hosts.service.js';
import { normalizeProfileConfigForSave } from './profile-config.js';
import { engineValidForProtocol, fieldsUnsupportedByEngine } from './profiles.schemas.js';
import { stripInapplicableTransportFields } from '../inbounds/xray-transport-fields.js';
import {
  adapterKeyForProfile,
  coreHoldsSeveralInbounds,
} from './node-adapter-keys.js';
import type {
  CreateBindingInput,
  CreateProfileInput,
  UpdateBindingInput,
  UpdateProfileInput,
  ListBindingsQuery,
  ListProfilesQuery,
} from './profiles.schemas.js';
import {
  mapBinding,
  mapProfile,
  type PublicBindingDto,
  type PublicProfileDto,
} from './profiles.mapper.js';

// ───── Errors ─────

export class ProfileNotFoundError extends Error {
  constructor(public id: string) {
    super(`Profile ${id} not found`);
    this.name = 'ProfileNotFoundError';
  }
}
export class BindingNotFoundError extends Error {
  constructor(public id: string) {
    super(`Binding ${id} not found`);
    this.name = 'BindingNotFoundError';
  }
}
export class ProfileNameTakenError extends Error {
  constructor(public name: string) {
    super(`Profile name "${name}" already in use`);
    this.name = 'ProfileNameTakenError';
  }
}
export class PortInUseError extends Error {
  constructor(public port: number, nodeName: string, conflictProfile: string) {
    super(
      `Port ${port} on node "${nodeName}" is already used by profile "${conflictProfile}". Pick a different port.`,
    );
    this.name = 'PortInUseError';
  }
}

// F-P1-b: candidate listen ports for a new binding, in preference order.
// Common HTTPS-alt ports that survive most ISP egress filters and read as
// ordinary TLS (good for REALITY / Hysteria masquerade). 443 first because it's
// the least suspicious; the rest are Cloudflare-proxy ports. Replaces the old
// blind "default to 443" that guaranteed a 409 when adding a second protocol to
// a node already listening on 443.
export const CANDIDATE_PORTS = [443, 8443, 2053, 2083, 2087, 2096] as const;

// pickFreePort returns the first CANDIDATE_PORTS entry not already taken on the
// node. If every candidate is in use it scans upward from 20000 for the first
// free port, so a node running many protocols still gets a usable suggestion
// instead of a guaranteed conflict. Pure (no DB) so it's unit-testable.
export function pickFreePort(used: Iterable<number>): number {
  const taken = new Set<number>(used);
  for (const p of CANDIDATE_PORTS) {
    if (!taken.has(p)) return p;
  }
  for (let p = 20000; p <= 65000; p++) {
    if (!taken.has(p)) return p;
  }
  // Pathological (45000 ports bound on one node): fall back to 443 and let the
  // createBinding conflict check surface a human 409.
  return 443;
}

// nextFreePortForNode suggests a listen port for a NEW binding on `nodeId`,
// avoiding every port already bound there. Powers the deploy modal's port
// pre-fill and the future in-node "+ Add protocol" flow.
export async function nextFreePortForNode(nodeId: string): Promise<number> {
  const bindings = await prisma.profileNodeBinding.findMany({
    where: { nodeId },
    select: { port: true },
  });
  return pickFreePort(bindings.map((b) => b.port));
}
export class NodeAlreadyBoundError extends Error {
  constructor(public profileId: string, public nodeId: string) {
    super(`Node ${nodeId} is already bound to profile ${profileId}`);
    this.name = 'NodeAlreadyBoundError';
  }
}
export class NodeNotFoundError extends Error {
  constructor(public id: string) {
    super(`Node ${id} not found`);
    this.name = 'NodeNotFoundError';
  }
}

// A5 - per-profile user reach: distinct users across every squad the profile is
// assigned to (group_profiles -> group_members), deduped. Users are explicit
// members of their squads (incl. the system "All" squad), so this also counts
// the "All" reach. One aggregate for the list; a scoped count for a single one.
//
// Soft-deleted users keep their group_members rows (we only flip
// users.deletedAt, the join row stays for restore-ability, same reason the
// squad member count joins users). Without the users join below, a profile on
// the "All" squad reports every ghost ever created, not the live reach.
async function userReachByProfile(): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ profile_id: string; user_count: number }[]>`
    SELECT gp.profile_id, COUNT(DISTINCT gm.user_id)::int AS user_count
    FROM group_profiles gp
    JOIN group_members gm ON gm.group_id = gp.group_id
    JOIN users u ON u.id = gm.user_id AND u.deleted_at IS NULL
    GROUP BY gp.profile_id
  `;
  return new Map(rows.map((r) => [r.profile_id, r.user_count]));
}

async function userReachForProfile(profileId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ user_count: number }[]>`
    SELECT COUNT(DISTINCT gm.user_id)::int AS user_count
    FROM group_profiles gp
    JOIN group_members gm ON gm.group_id = gp.group_id
    JOIN users u ON u.id = gm.user_id AND u.deleted_at IS NULL
    WHERE gp.profile_id = ${profileId}::uuid
  `;
  return rows[0]?.user_count ?? 0;
}

// ───── Profile CRUD ─────

export async function createProfile(input: CreateProfileInput): Promise<PublicProfileDto> {
  const existing = await prisma.profile.findUnique({ where: { name: input.name } });
  if (existing) throw new ProfileNameTakenError(input.name);

  const configToStore = normalizeProfileConfigForSave(input.protocol, input.config);

  const created = await prisma.$transaction(async (tx) => {
    const p = await tx.profile.create({
      data: {
        name: input.name,
        protocol: input.protocol,
        engine: input.engine ?? null,
        description: input.description ?? null,
        config: configToStore as never,
        enabled: input.enabled,
      },
    });
    // Slice 26 invariant: every new profile auto-attaches to "All" squad.
    await tx.groupProfile.upsert({
      where: { groupId_profileId: { groupId: ALL_SQUAD_ID, profileId: p.id } },
      create: { groupId: ALL_SQUAD_ID, profileId: p.id },
      update: {},
    });
    return p;
  });

  eventBus.emit('profile.created', { profileId: created.id });
  return mapProfile({ ...created, _count: { bindings: 0 } });
}

export async function listProfiles(q: ListProfilesQuery): Promise<PublicProfileDto[]> {
  const profiles = await prisma.profile.findMany({
    where: q.protocol ? { protocol: q.protocol } : undefined,
    orderBy: [{ protocol: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { bindings: true } } },
  });
  const reach = await userReachByProfile();
  return profiles.map((p) => mapProfile(p, reach.get(p.id) ?? 0));
}

export async function getProfileById(id: string): Promise<PublicProfileDto> {
  const profile = await prisma.profile.findUnique({
    where: { id },
    include: { _count: { select: { bindings: true } } },
  });
  if (!profile) throw new ProfileNotFoundError(id);
  return mapProfile(profile, await userReachForProfile(id));
}

export async function updateProfile(
  id: string,
  input: UpdateProfileInput,
): Promise<PublicProfileDto> {
  const existing = await prisma.profile.findUnique({ where: { id } });
  if (!existing) throw new ProfileNotFoundError(id);

  if (input.name && input.name !== existing.name) {
    const collision = await prisma.profile.findUnique({ where: { name: input.name } });
    if (collision) throw new ProfileNameTakenError(input.name);
  }

  const data: Prisma.ProfileUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.engine !== undefined) {
    if (!engineValidForProtocol(existing.protocol, input.engine)) {
      throw new Error(
        `engine "${input.engine}" is not valid for protocol "${existing.protocol}"`,
      );
    }
    data.engine = input.engine;
  }

  if (input.config !== undefined) {
    // Same pipeline as create, and `existing.config` is what makes an omission
    // not a deletion: the update REPLACES config, and the only editor of a
    // profile rebuilds it from the controls it renders - which cannot include a
    // secret it must not show.
    const nextConfig = normalizeProfileConfigForSave(
      existing.protocol,
      input.config,
      existing.config,
    );
    data.config = nextConfig as never;

    // The third door into a bad deploy. `parsed` above proves the profile is
    // valid ON ITS OWN; every binding deploys it merged with that binding's
    // overrides, and the merge is what xray sees. Flipping a REALITY profile's
    // transport to raw is fine standalone and still lands a node in a restart
    // loop if a binding overrides `network` to ws. The engine/config guard
    // right below already reasons this way - on the pair the profile ENDS UP
    // with, not on what one request happened to carry; this is the same
    // reasoning across the profile/binding seam.
    const bindings = await prisma.profileNodeBinding.findMany({
      where: { profileId: id },
      include: {
        node: {
          select: { name: true, portHoppingStart: true, portHoppingEnd: true },
        },
      },
    });
    for (const b of bindings) {
      assertNoNewConfigViolations(
        existing.protocol,
        { profileConfig: existing.config, overrides: b.overrides },
        { profileConfig: nextConfig, overrides: b.overrides },
        `Profile "${existing.name}" on node "${b.node.name}"`,
      );
    }
    // ...and the one thing no schema can judge, because the answer lives on the
    // machine: whether these nodes actually redirect the ports this profile
    // tells clients to hop across. Merged config, same as above - a binding can
    // override the range.
    assertPortHoppingFitsNodes(
      existing.protocol,
      input.name ?? existing.name,
      nextConfig,
      bindings.map((b) => b.node),
    );
  }

  // The engine and the config can move in separate requests, so the guard has
  // to run on the pair the profile ENDS UP with, not on what this request
  // happened to carry. Without it a profile could be given an abusePolicy
  // first and switched to sing-box second, and the policy would go dark.
  const effectiveEngine = input.engine !== undefined ? input.engine : existing.engine;
  const effectiveConfig = data.config !== undefined ? data.config : existing.config;
  const unsupported = fieldsUnsupportedByEngine(effectiveEngine, effectiveConfig);
  if (unsupported.length > 0) {
    throw new Error(
      `${unsupported.join(', ')} not supported by the sing-box engine (use the xray engine)`,
    );
  }

  // The third door into the single-inbound collision. Two moves reach it from
  // here: enabling a profile that was bound while disabled, and re-pinning the
  // engine, which relocates the profile onto a DIFFERENT node adapter that may
  // already be taken. An edit that moves neither is not re-judged - a pair that
  // predates this guard must stay renamable, or the only way out of a legacy
  // collision would be to delete one side.
  const effectiveEnabled = input.enabled !== undefined ? input.enabled : existing.enabled;
  const engineMoved = input.engine !== undefined && input.engine !== existing.engine;
  const enabledMoved = input.enabled === true && !existing.enabled;
  if (effectiveEnabled && (engineMoved || enabledMoved)) {
    const deployed = await prisma.profileNodeBinding.findMany({
      where: { profileId: id, enabled: true },
      include: { node: { select: { id: true, name: true } } },
    });
    for (const b of deployed) {
      await assertNodeCoreFree({
        nodeId: b.node.id,
        nodeName: b.node.name,
        profileName: input.name ?? existing.name,
        protocol: existing.protocol,
        engine: (effectiveEngine ?? null) as string | null,
      });
    }
  }

  const updated = await prisma.profile.update({
    where: { id },
    data,
    include: { _count: { select: { bindings: true } } },
  });
  eventBus.emit('profile.updated', { profileId: id });
  return mapProfile(updated, await userReachForProfile(id));
}

export async function deleteProfile(id: string): Promise<void> {
  const profile = await prisma.profile.findUnique({
    where: { id },
    include: { bindings: { select: { nodeId: true } } },
  });
  if (!profile) throw new ProfileNotFoundError(id);

  const affectedNodeIds = profile.bindings.map((b) => b.nodeId);
  await prisma.profile.delete({ where: { id } });

  eventBus.emit('profile.deleted', { profileId: id, affectedNodeIds });
}

// ───── Bindings CRUD ─────

export async function createBinding(input: CreateBindingInput): Promise<PublicBindingDto> {
  const profile = await prisma.profile.findUnique({ where: { id: input.profileId } });
  if (!profile) throw new ProfileNotFoundError(input.profileId);
  const node = await prisma.node.findFirst({
    where: { id: input.nodeId, deletedAt: null },
  });
  if (!node) throw new NodeNotFoundError(input.nodeId);

  // Pre-flight uniqueness checks for friendlier error messages.
  const portConflict = await prisma.profileNodeBinding.findUnique({
    where: { nodeId_port: { nodeId: input.nodeId, port: input.port } },
    include: { profile: { select: { name: true } } },
  });
  if (portConflict) throw new PortInUseError(input.port, node.name, portConflict.profile.name);
  const dupBinding = await prisma.profileNodeBinding.findUnique({
    where: {
      profileId_nodeId: { profileId: input.profileId, nodeId: input.nodeId },
    },
  });
  if (dupBinding) throw new NodeAlreadyBoundError(input.profileId, input.nodeId);

  // The overrides arrive here having met no schema at all. Judge the merge they
  // produce - that is what the sync queue ships to the node.
  assertNoNewConfigViolations(
    profile.protocol,
    { profileConfig: profile.config, overrides: null },
    { profileConfig: profile.config, overrides: input.overrides ?? null },
    `Binding profile "${profile.name}" to node "${node.name}"`,
  );
  // Binding is the other direction into the same mismatch: the profile's range
  // was fine against the nodes it had, and this adds one that does not redirect
  // it.
  assertPortHoppingFitsNodes(
    profile.protocol,
    profile.name,
    resolveBindingConfig(profile.config, input.overrides ?? null, profile.protocol),
    [node],
  );
  // And the pair in the other dimension: not "does this port fit the node" but
  // "is the node's core for this protocol already taken". A disabled binding
  // cannot evict anything, so only a live one is judged.
  if (input.enabled && profile.enabled) {
    await assertNodeCoreFree({
      nodeId: node.id,
      nodeName: node.name,
      profileName: profile.name,
      protocol: profile.protocol,
      engine: profile.engine,
    });
  }

  const created = await prisma.profileNodeBinding.create({
    data: {
      profileId: input.profileId,
      nodeId: input.nodeId,
      port: input.port,
      publicHost: input.publicHost ?? null,
      publicPort: input.publicPort ?? null,
      overrides: (input.overrides as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      enabled: input.enabled,
    },
  });
  // Slice 30: every new binding ships with one Default host so the
  // subscription generator (which iterates bindings × hosts) has something
  // to emit. Admin can later add extras with different SNI / fingerprint.
  await ensureDefaultHost(created.id);
  eventBus.emit('binding.created', {
    bindingId: created.id,
    profileId: created.profileId,
    nodeId: created.nodeId,
  });
  return mapBinding(created);
}

export async function listBindings(q: ListBindingsQuery): Promise<PublicBindingDto[]> {
  // Skip bindings whose node was soft-deleted, otherwise DeployProfileModal
  // / profile cards would carry phantom rows from removed nodes.
  const where: Prisma.ProfileNodeBindingWhereInput = { node: { deletedAt: null } };
  if (q.nodeId) where.nodeId = q.nodeId;
  if (q.profileId) where.profileId = q.profileId;
  const rows = await prisma.profileNodeBinding.findMany({
    where,
    orderBy: [{ nodeId: 'asc' }, { port: 'asc' }],
  });
  return rows.map(mapBinding);
}

export async function getBindingById(id: string): Promise<PublicBindingDto> {
  const b = await prisma.profileNodeBinding.findUnique({ where: { id } });
  if (!b) throw new BindingNotFoundError(id);
  return mapBinding(b);
}

export async function updateBinding(
  id: string,
  input: UpdateBindingInput,
): Promise<PublicBindingDto> {
  const existing = await prisma.profileNodeBinding.findUnique({
    where: { id },
    include: {
      profile: { select: { name: true, protocol: true, config: true } },
      node: { select: { name: true, portHoppingStart: true, portHoppingEnd: true } },
    },
  });
  if (!existing) throw new BindingNotFoundError(id);

  if (input.overrides !== undefined) {
    assertNoNewConfigViolations(
      existing.profile.protocol,
      { profileConfig: existing.profile.config, overrides: existing.overrides },
      { profileConfig: existing.profile.config, overrides: input.overrides },
      `Binding "${existing.profile.name}" on node "${existing.node.name}"`,
    );
    // The third door, and the one a check on createBinding alone would leave
    // open: an override can move the range on a binding that already exists.
    assertPortHoppingFitsNodes(
      existing.profile.protocol,
      existing.profile.name,
      resolveBindingConfig(existing.profile.config, input.overrides, existing.profile.protocol),
      [existing.node],
    );
  }

  // Enabling a binding deploys it, so it walks into the same collision
  // createBinding is guarded against - a check on creation alone would leave
  // "bind it disabled, enable it later" wide open.
  if (input.enabled === true && !existing.enabled) {
    const owner = await prisma.profile.findUnique({
      where: { id: existing.profileId },
      select: { id: true, enabled: true, engine: true },
    });
    if (owner?.enabled) {
      await assertNodeCoreFree({
        nodeId: existing.nodeId,
        nodeName: existing.node.name,
        profileName: existing.profile.name,
        protocol: existing.profile.protocol,
        engine: owner.engine,
      });
    }
  }

  if (input.port !== undefined && input.port !== existing.port) {
    const portConflict = await prisma.profileNodeBinding.findUnique({
      where: { nodeId_port: { nodeId: existing.nodeId, port: input.port } },
      include: {
        profile: { select: { name: true } },
        node: { select: { name: true } },
      },
    });
    if (portConflict && portConflict.id !== id) {
      throw new PortInUseError(input.port, portConflict.node.name, portConflict.profile.name);
    }
  }

  const data: Prisma.ProfileNodeBindingUpdateInput = {};
  if (input.port !== undefined) data.port = input.port;
  if (input.publicHost !== undefined) data.publicHost = input.publicHost;
  if (input.publicPort !== undefined) data.publicPort = input.publicPort;
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.overrides !== undefined) {
    data.overrides =
      input.overrides === null
        ? Prisma.JsonNull
        : (input.overrides as Prisma.InputJsonValue);
  }

  const updated = await prisma.profileNodeBinding.update({ where: { id }, data });
  eventBus.emit('binding.updated', {
    bindingId: id,
    profileId: updated.profileId,
    nodeId: updated.nodeId,
  });
  return mapBinding(updated);
}

export async function deleteBinding(id: string): Promise<void> {
  const existing = await prisma.profileNodeBinding.findUnique({ where: { id } });
  if (!existing) throw new BindingNotFoundError(id);
  await prisma.profileNodeBinding.delete({ where: { id } });
  eventBus.emit('binding.deleted', {
    bindingId: id,
    profileId: existing.profileId,
    nodeId: existing.nodeId,
  });
}

// ───── Resolution ─────

/**
 * Resolve the deployable inbound config for a (profile, node) pair: shallow
 * merge of `profile.config` + `binding.overrides`. Used by the inbound-sync
 * queue when shipping configs to node-agents and by the subscription
 * generator when emitting client URIs.
 *
 * Shallow merge is intentional, overrides should mention specific top-level
 * fields (`acmeDomain`, `serverPsk`, etc.). Deep merge would silently mask
 * partial-array edits which is rarely what admins mean.
 *
 * For xray the merge is then swept by `stripInapplicableTransportFields`, the
 * same normaliser a profile goes through when it is SAVED. It has to happen
 * here too, because `network` is one of the things an override may change and
 * the merge is shallow: a REALITY+raw profile carrying Vision, bound with
 * `overrides: {network: 'grpc'}`, produced a node config on gRPC that still
 * demanded Vision.
 *
 * That is not a wasted option, it is an outage, and it was measured rather than
 * reasoned about - xray 26.3.27, real client dialling a real node:
 *
 *   raw  + Vision both ends       traffic flows
 *   grpc + no flow both ends      traffic flows
 *   grpc + Vision both ends       no traffic, the gRPC tunnel dies
 *   grpc + Vision on the SERVER   no traffic: "account <uuid> is rejected since
 *                                 the client flow is empty. Note that the pure
 *                                 TLS proxy has certain TLS in TLS characters."
 *
 * The last line is the one this fixes, and it is the pairing the panel actually
 * produces: `core-adapters/xray/uri.ts` has always dropped `flow` for gRPC, so
 * the client half is empty by construction and only the server half was wrong.
 * It closes the open question left in docs/remnawave-compat.md §24.
 */
export function resolveBindingConfig(
  profileConfig: unknown,
  overrides: unknown,
  protocol?: string,
): Record<string, unknown> {
  const base = (profileConfig ?? {}) as Record<string, unknown>;
  const ov = (overrides ?? {}) as Record<string, unknown>;
  const merged = { ...base, ...ov };
  return protocol === 'xray' ? stripInapplicableTransportFields(merged) : merged;
}

/**
 * Fingerprint of a schema violation: the field it lands on and the kind of
 * failure, without the offending value. Two configs that break the same rule on
 * the same field share a fingerprint even when the messages name different
 * values ("a ws inbound" vs "a kcp inbound"). Maps fingerprint -> message, so
 * the caller can report the ones that are new.
 */
function issueFingerprints(schema: z.ZodType, config: unknown): Map<string, string> {
  const res = schema.safeParse(config);
  const out = new Map<string, string>();
  if (res.success) return out;
  for (const i of res.error.issues) {
    const path = i.path.map(String).join('.') || '(root)';
    out.set(`${path} ${i.code}`, `${path}: ${i.message}`);
  }
  return out;
}

export class InvalidBindingConfigError extends Error {
  constructor(public readonly issues: string[], subject: string) {
    super(`${subject} would deploy a config its protocol refuses: ${issues.join('; ')}`);
    this.name = 'InvalidBindingConfigError';
  }
}

/**
 * Gate the config a binding will actually DEPLOY - `profile.config` merged with
 * `binding.overrides` - against the protocol's own schema.
 *
 * Every rule that schema carries (REALITY's three transports, the
 * VLESS-Encryption halves, the post-quantum pairs) ran on `Profile.config`
 * alone, at profile-save time. `overrides` never met a schema at all:
 * `CreateBindingSchema` types it `z.record(z.string(), z.unknown())` and the
 * service cast it straight into Prisma. So
 *
 *   POST /api/bindings {profileId: <a REALITY profile>, overrides: {"network":"ws"}}
 *
 * answered 201, and the merged config - which is what reaches the node - was
 * one xray refuses to load, with the crash loop that costs every other inbound
 * on that node. The doc comment on the field said "Validated by the protocol's
 * config schema (partial)". Nothing anywhere did that. The hole was never
 * specific to the REALITY rule: it let past any rule the schema has or gains.
 *
 * Hence the check is on the MERGE, not on the overrides alone. Overrides are
 * partial by design (`acmeDomain`, `serverPsk`, a per-node key) and half a
 * config cannot be judged: `security` can sit in the profile while `network`
 * arrives from the binding, and only the two together say whether xray starts.
 *
 * What it promises, exactly: not "the deployed config is valid" but *this
 * request introduces no violation that was not already there*. A profile stored
 * before a rule existed is already broken, and stays bindable, renameable and
 * fixable - what it cannot do is acquire a NEW broken field. A gate that simply
 * demanded validity would trap precisely the operator digging out, since every
 * profile saved before the REALITY transport check landed is invalid through no
 * act of theirs. Fingerprints are (path, code), so trading one refused
 * transport for another on an already-refused field reads as "still broken",
 * not as "made worse".
 */
export function assertNoNewConfigViolations(
  protocol: string,
  before: { profileConfig: unknown; overrides: unknown },
  after: { profileConfig: unknown; overrides: unknown },
  subject: string,
): void {
  const schema = PROTOCOL_CONFIG_SCHEMAS[protocol as keyof typeof PROTOCOL_CONFIG_SCHEMAS];
  if (!schema) return; // unknown protocol: nothing to judge it with
  const post = issueFingerprints(schema, resolveBindingConfig(after.profileConfig, after.overrides, protocol));
  if (post.size === 0) return;
  const pre = issueFingerprints(schema, resolveBindingConfig(before.profileConfig, before.overrides, protocol));
  const fresh = [...post].filter(([k]) => !pre.has(k)).map(([, msg]) => msg);
  if (fresh.length > 0) throw new InvalidBindingConfigError(fresh, subject);
}


/**
 * A port-hopping range the node would not catch.
 *
 * Separate from InvalidBindingConfigError because it is a different KIND of
 * refusal: nothing about the config is malformed, and the same profile is
 * perfectly valid against a node installed with a wider range. What is wrong is
 * the pair.
 */
export class PortHoppingOutsideNodeRangeError extends Error {
  constructor(
    public readonly profileName: string,
    public readonly nodeName: string,
    public readonly wanted: { start: number; end: number },
    public readonly nodeRange: { start: number; end: number },
  ) {
    super(
      `Profile "${profileName}" hops over ports ${wanted.start}-${wanted.end}, but node ` +
        `"${nodeName}" only redirects ${nodeRange.start}-${nodeRange.end} to its Hysteria ` +
        `listener. Clients would rotate onto ports that node is not catching. Narrow the ` +
        `profile's range, or re-run the node installer with ` +
        `--hysteria-port-range ${wanted.start}-${wanted.end}.`,
    );
    this.name = 'PortHoppingOutsideNodeRangeError';
  }
}

/**
 * Refuse a hysteria profile whose port-hopping range a bound node does not
 * redirect.
 *
 * The range is chosen when a node is INSTALLED (`--hysteria-port-range`,
 * default 20000-50000) and turned into an iptables REDIRECT. The panel had no
 * way to know it, so `hysteria-port-hopping.test.ts` carried a case asserting
 * that a range outside it saves fine, with a comment explaining that the panel
 * cannot know better. It could not - until the node started reporting what it
 * actually redirects, which is what made that exception stop being true. An
 * exception should not outlive its subject.
 *
 * What it costs to be wrong here is invisible on both sides: the client honestly
 * rotates its destination port across the profile's range, the ports outside the
 * node's range reach nothing, and neither the panel nor the node logs a thing.
 * The connection simply fails, on some attempts and not others.
 *
 * Gated on what the node REPORTED, never on a guess. A node that reports nothing
 * - no rule, no iptables, an older agent - is not judged: refusing a save
 * against a number the panel does not have would be the very failure this
 * replaces, in the other direction.
 */
export function assertPortHoppingFitsNodes(
  protocol: string,
  profileName: string,
  config: unknown,
  nodes: { name: string; portHoppingStart: number | null; portHoppingEnd: number | null }[],
): void {
  if (protocol !== 'hysteria' || config == null || typeof config !== 'object') return;
  const cfg = config as { portHoppingStart?: unknown; portHoppingEnd?: unknown };
  const start = Number(cfg.portHoppingStart);
  const end = Number(cfg.portHoppingEnd);
  // Port-hopping off, or half a pair - the schema refuses half a pair on its
  // own and says why, so there is nothing for this to add.
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) return;

  for (const node of nodes) {
    const ns = node.portHoppingStart;
    const ne = node.portHoppingEnd;
    if (ns == null || ne == null) continue; // never reported: nothing to judge against
    if (start >= ns && end <= ne) continue; // a subset, which is the whole requirement
    throw new PortHoppingOutsideNodeRangeError(
      profileName,
      node.name,
      { start, end },
      { start: ns, end: ne },
    );
  }
}

export class NodeCoreAlreadyServingError extends Error {
  constructor(
    public readonly profileName: string,
    public readonly nodeName: string,
    public readonly protocol: string,
    public readonly engine: string,
    public readonly occupantName: string,
    public readonly occupantPort: number,
  ) {
    super(
      `Node "${nodeName}" already serves ${protocol} on port ${occupantPort} for profile ` +
        `"${occupantName}". Its ${engine} core holds ONE inbound at a time, so deploying ` +
        `"${profileName}" to the same node replaces that one instead of adding to it: the ` +
        `node would listen on a single port and every link already handed out for the ` +
        `other would reach nothing, with neither side reporting a failure. Deploy ` +
        `"${profileName}" to a different node, or disable "${occupantName}" on this one.`,
    );
    this.name = 'NodeCoreAlreadyServingError';
  }
}

/**
 * Refuse a second live inbound on a node whose core can only hold one.
 *
 * The node dispatches per (protocol, engine) pair and every adapter but xray
 * stores a single inbound: `ApplyInbound` overwrites it and restarts the core,
 * so the second push in the list silently evicts the first. Nothing anywhere
 * says so - `applied` counts both, the heartbeat reports the core running, and
 * the subscription keeps emitting the evicted inbound's host, port and secret.
 * Measured 2026-08-30 with two mtproto profiles on one node; see
 * node-adapter-keys.ts for the numbers.
 *
 * "Live" is the same condition the push queue uses (`inbounds.queue.ts`):
 * binding enabled AND profile enabled. A disabled pair is not deployed, so it
 * cannot evict anything, and refusing it would block the very move that fixes
 * the collision - disable one, then bind the other.
 *
 * Keyed on the pair rather than the protocol because that is what the node
 * matches on: an xray profile on the native core and an xray profile pinned to
 * sing-box are two different adapters and do not collide, while two
 * shadowsocks profiles do even though neither mentions xray.
 */
export async function assertNodeCoreFree(args: {
  nodeId: string;
  nodeName: string;
  profileName: string;
  protocol: string;
  engine: string | null;
}): Promise<void> {
  if (coreHoldsSeveralInbounds(args.protocol, args.engine)) return;
  const wantKey = adapterKeyForProfile(args.protocol, args.engine);

  // No "ignore myself" argument, because in every caller the subject is already
  // outside this set, and a parameter that can never fire reads like a
  // safeguard while being none. Two mutations of it passed green, which is what
  // said so. Per caller:
  //   createBinding   - the row does not exist yet, and a second binding of the
  //                     same profile to the same node is refused above by
  //                     NodeAlreadyBoundError, so that check must stay first.
  //   updateBinding   - only runs on the disabled -> enabled transition, so the
  //                     subject fails `enabled: true`.
  //   updateProfile   - only runs when `enabled` or `engine` MOVES. On enabling,
  //                     the profile is still disabled in the row and fails
  //                     `profile: { enabled: true }`; on an engine change, the
  //                     stored engine is the old one and keys differently.
  // Adding a caller outside those shapes means adding the exclusion back, with
  // a case that reaches it.
  const live = await prisma.profileNodeBinding.findMany({
    where: { nodeId: args.nodeId, enabled: true, profile: { enabled: true } },
    include: { profile: { select: { id: true, name: true, protocol: true, engine: true } } },
    orderBy: { port: 'asc' },
  });

  for (const b of live) {
    if (adapterKeyForProfile(b.profile.protocol, b.profile.engine) !== wantKey) continue;
    throw new NodeCoreAlreadyServingError(
      args.profileName,
      args.nodeName,
      args.protocol,
      args.engine || wantKey.split('|')[1],
      b.profile.name,
      b.port,
    );
  }
}
