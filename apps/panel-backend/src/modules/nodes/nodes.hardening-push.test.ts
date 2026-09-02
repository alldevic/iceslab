import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HardeningSchema } from './nodes.schemas.js';

/**
 * A hardening key that changes the node's running config must be pushed, not
 * only stored.
 *
 * `updateNode` only emits `node.updated` - the event the inbound-sync worker
 * listens on - when one of EGRESS_HARDENING_KEYS actually changed. A key that
 * belongs in that list and is not in it saves cleanly, comes back from the API
 * set, draws its switch as on in the panel, and never reaches the machine. The
 * operator has no way to tell: nothing errors, nothing logs, and the node keeps
 * doing what it did.
 *
 * Measured 2026-09-02 on s1: `bridgeNonXrayInbounds` was turned on through the
 * API, the node returned it in its own DTO, and the node's sing-box config still
 * held the single `direct` outbound it had before. No push had happened.
 *
 * So the list is checked against the schema rather than trusted. Keys that are
 * genuinely inert on the node are named below with why; everything else has to
 * be pushed.
 */

const src = readFileSync(
  fileURLToPath(new URL('./nodes.service.ts', import.meta.url)),
  'utf8',
);

/** Keys that legitimately need no push, each with the reason. */
const NO_PUSH_NEEDED: Record<string, string> = {
  ufwLockdown: 'install-time switch: the bootstrap command renders it, the running config has no counterpart.',
  fail2ban: 'install-time switch, same as ufwLockdown.',
  sshAllowlist: 'install-time switch, same as ufwLockdown.',
  pool: 'F2 labels are panel-side selection metadata; the node never sees them.',
};

describe('hardening keys that change the node are pushed to it', () => {
  const listed = (): string[] => {
    const m = /const EGRESS_HARDENING_KEYS = \[([^\]]*)\]/.exec(src);
    if (!m) throw new Error('EGRESS_HARDENING_KEYS not found in nodes.service.ts');
    return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  };

  it('reads the list at all', () => {
    // The control: an empty parse would make every assertion below vacuous,
    // and "found nothing" is also what a renamed constant looks like.
    expect(listed().length).toBeGreaterThan(1);
    expect(listed()).toContain('egressPolicy');
  });

  it('covers every hardening key that is not explained as inert', () => {
    const schemaKeys = Object.keys(
      (HardeningSchema.unwrap().unwrap() as unknown as { shape: Record<string, unknown> }).shape,
    );
    // Control: the schema must actually have been read.
    expect(schemaKeys).toContain('egressPolicy');

    const pushed = new Set(listed());
    const missing = schemaKeys.filter((k) => !pushed.has(k) && !(k in NO_PUSH_NEEDED));
    expect(
      missing,
      'these hardening keys change what the node runs but no edit to them is pushed: ' +
        'the panel would show them applied while the machine keeps its old behaviour. ' +
        'Add them to EGRESS_HARDENING_KEYS, or to NO_PUSH_NEEDED with the reason they are inert',
    ).toEqual([]);
  });

  it('keeps no explanation for a key that no longer exists', () => {
    const schemaKeys = new Set(
      Object.keys(
        (HardeningSchema.unwrap().unwrap() as unknown as { shape: Record<string, unknown> }).shape,
      ),
    );
    expect(
      Object.keys(NO_PUSH_NEEDED).filter((k) => !schemaKeys.has(k)),
      'an explanation that outlived its key reads as a guarantee about a field nobody sends',
    ).toEqual([]);
  });
});
