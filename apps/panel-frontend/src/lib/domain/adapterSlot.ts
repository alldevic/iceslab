/**
 * One inbound per adapter on a node (A-055, BACK 0c1fb86).
 *
 * The agent hands an inbound to an adapter by (protocol, engine), and for
 * AmneziaWG by (protocol, generation). Every adapter but native xray holds ONE
 * inbound: a second binding of the same adapter on a node is refused 409
 * ADAPTER_SLOT_TAKEN { protocol, engine, heldBy }, on POST /api/hosts and
 * POST /api/bindings alike.
 *
 * ⚠ The key and the one shared adapter are a hand mirror of
 * `apps/panel-backend/src/modules/nodes/node-adapter-slot.ts` (adapterSlot,
 * MULTI). The server stays the judge: the wizard uses this only to not offer
 * a second host it knows would be refused, and the refusal is still read.
 */

const MULTI = new Set(['xray|xray']);

export function adapterSlot(p: { protocol: string; effectiveEngine: string; awgProtocol?: number | null }): string {
  if (p.protocol === 'amneziawg') return `amneziawg|${p.awgProtocol === 3 ? 3 : 1}`;
  return `${p.protocol}|${p.effectiveEngine}`;
}

/** The adapter takes more than one inbound (native xray only, today). */
export function slotShared(slot: string): boolean {
  return MULTI.has(slot);
}

type SlotProfile = { id: string; name: string; protocol: string; effectiveEngine: string; awgProtocol?: number | null };

/**
 * Candidates that cannot be picked because a picked profile already holds
 * their adapter on this node: id -> the name of the one that holds it.
 */
export function slotHeldBy(candidates: readonly SlotProfile[], selected: readonly string[]): Map<string, string> {
  const picked = new Set(selected);
  const holder = new Map<string, string>();
  for (const p of candidates) {
    if (!picked.has(p.id)) continue;
    const slot = adapterSlot(p);
    if (!slotShared(slot) && !holder.has(slot)) holder.set(slot, p.name);
  }
  const out = new Map<string, string>();
  for (const p of candidates) {
    if (picked.has(p.id)) continue;
    const by = holder.get(adapterSlot(p));
    if (by !== undefined) out.set(p.id, by);
  }
  return out;
}

/**
 * «Select all» that stays within one inbound per adapter: keeps the current
 * picks and adds candidates in order, skipping any whose adapter is taken.
 */
export function addOnePerSlot(selected: readonly string[], candidates: readonly SlotProfile[]): string[] {
  const out = [...selected];
  const taken = new Set(
    candidates.filter((p) => selected.includes(p.id)).map(adapterSlot).filter((s) => !slotShared(s)),
  );
  for (const p of candidates) {
    if (out.includes(p.id)) continue;
    const slot = adapterSlot(p);
    if (!slotShared(slot)) {
      if (taken.has(slot)) continue;
      taken.add(slot);
    }
    out.push(p.id);
  }
  return out;
}

/** 409 ADAPTER_SLOT_TAKEN, read with the input checked first. */
export interface AdapterSlotRefusal {
  protocol: string;
  engine: string;
  heldBy: string;
  message: string;
}

export function adapterSlotRefusal(err: unknown): AdapterSlotRefusal | null {
  if (!err || typeof err !== 'object') return null;
  const res = (err as { response?: unknown }).response;
  if (!res || typeof res !== 'object') return null;
  const { status, data } = res as { status?: unknown; data?: unknown };
  if (status !== 409 || !data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.error !== 'ADAPTER_SLOT_TAKEN') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return { protocol: str(d.protocol), engine: str(d.engine), heldBy: str(d.heldBy), message: str(d.message) };
}
