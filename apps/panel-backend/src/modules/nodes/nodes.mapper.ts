import type { Node } from '../../generated/prisma/client.js';
import type { NodeCoreRestarts, NodeEgressTune } from '@iceslab/shared';

// G (Zashchita / hardening) - public shape of the nodes.hardening jsonb blob.
// Mirrors HardeningInput in nodes.schemas.ts; the frontend reads this to seed
// the edit form so it must live on the public DTO.
export interface HardeningDto {
  ufwLockdown?: boolean;
  fail2ban?: boolean;
  sshAllowlist?: string[];
  // The keys below are not wizard toggles, but they live in the same blob and
  // an update REPLACES it, so they have to be visible for the editor to send
  // them back untouched. Left as unknown on purpose: this DTO exists so the
  // form can round-trip them, not so it can interpret them (each has its own
  // schema in nodes.schemas.ts).
  /** F2: cold-pool / hotswap labels (asn, provider, burned). */
  pool?: unknown;
  /** B1: which flows leave this node by which way out. */
  egressPolicy?: unknown;
  /** B2a: the zapret2 desync channel config. */
  zapret2?: unknown;
  /** Bridge A: route this node's non-xray cores through its local xray. Unlike
   *  the three above this IS a wizard toggle, so it is typed: the editor has to
   *  read it to draw the switch in the right position, and an `unknown` here
   *  would leave the switch off on a node that has it on. */
  bridgeNonXrayInbounds?: boolean;
}

// Shape of the nodes.coreRestarts jsonb blob. Defined once in @iceslab/shared
// (NodeCoreRestarts) and re-exported here for the modules that already import
// node DTO types from this file; panel-frontend imports the same type straight
// from shared, so there is a single definition to keep in sync.
//
// ⚠ `null` on the node DTO means "no reporting agent has checked in", NOT
// "zero restarts". Older agents never send this.
export type { NodeCoreRestarts, NodeEgressTune } from '@iceslab/shared';

export interface PublicNodeDto {
  id: string;
  name: string;
  address: string;
  protocol: string;
  countryCode: string | null;
  status: string;
  lastStatusChange: string | null;
  lastStatusMessage: string | null;
  /** See NodeCoreRestarts. null = never reported (not the same as zero). */
  coreRestarts: NodeCoreRestarts | null;
  /** F3: the DPI-bypass strategy this node found for itself and is running.
   *  null = never reported, which is not the same as "nothing was blocked"
   *  (that is a reported tune with working: 0). */
  egressTune: NodeEgressTune | null;
  // T7: proxy-core version reported by the agent (e.g. xray "26.3.27"), NULL
  // until a versioned agent checks in. Shown on the node card; the cascade form
  // uses it to warn before selecting an old node as a balancer entry.
  coreVersion: string | null;
  consumptionMultiplier: string;
  // Slice 27.5: region grouping + capacity hint.
  regionId: string | null;
  maxUsers: number | null;
  // B3/G: FQDN for REALITY self-steal serverName + future ACME.
  domain: string | null;
  // G - probe-resistance toggles (Zashchita wizard). NULL = no hardening.
  hardening: HardeningDto | null;
  // WARP egress on/off (per-node). Creds (secretKey/token) are never exposed.
  warpEnabled: boolean;
  // Engine-choice: sing-box engine installed alongside the native core.
  singboxEngine: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Public DTO for a node, strips internal cert/key material and lifecycle
 * fields (deletedAt, publicKey blob).
 */
export function mapNodeToPublic(node: Node): PublicNodeDto {
  return {
    id: node.id,
    name: node.name,
    address: node.address,
    protocol: node.protocol,
    countryCode: node.countryCode,
    status: node.status,
    lastStatusChange: node.lastStatusChange?.toISOString() ?? null,
    lastStatusMessage: node.lastStatusMessage,
    coreRestarts: (node.coreRestarts as NodeCoreRestarts | null) ?? null,
    egressTune: (node.egressTune as NodeEgressTune | null) ?? null,
    coreVersion: node.coreVersion,
    consumptionMultiplier: node.consumptionMultiplier.toString(),
    regionId: node.regionId,
    maxUsers: node.maxUsers,
    domain: node.domain,
    hardening: (node.hardening as HardeningDto | null) ?? null,
    warpEnabled: node.warpEnabled,
    singboxEngine: node.singboxEngine,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
  };
}

export interface BootstrapInfo {
  /** Short single-use token (URL-safe). Survives 4 KB TTY paste limit. */
  token: string;
  /** ISO timestamp when the token stops being redeemable. */
  expiresAt: string;
  /** Pre-rendered single-line install command, ready for copy-paste. */
  command: string;
}

export interface CreateNodeResponseDto extends PublicNodeDto {
  /**
   * Base64url-encoded one-time payload containing the node's mTLS cert+key
   * and the panel CA. Kept for the manual / air-gapped flow (Download +
   * scp + `--payload-file`), most admins should use the bootstrap-token
   * flow below instead.
   */
  payload: string;
  /**
   * Bootstrap info for the network-fetch flow: admin pastes a short
   * command on the node, the install-script curls the panel for the full
   * payload over HTTP. No 4096-byte TTY paste limit, single command.
   */
  bootstrap: BootstrapInfo;
}

export function mapNodeWithPayload(
  node: Node,
  payload: string,
  bootstrap: BootstrapInfo,
): CreateNodeResponseDto {
  return { ...mapNodeToPublic(node), payload, bootstrap };
}
