// The obfuscation block is written twice, in two languages, for the two ends of
// the same tunnel: here for the client `.conf` the buyer imports, and on the
// node (internal/core/amneziawg/config.go, renderObfuscation) for the server
// config. Both read the same pushed values, so the NUMBERS agree by
// construction. What does not agree by construction is which keys each side
// emits and how it spells them — and AmneziaWG hashes these parameters into
// the handshake, so a mismatch does not warn, does not log and does not fail a
// healthcheck. The tunnel simply never decrypts, for every user of that
// inbound.
//
// Measured before writing: the node side was observed by NOTHING (renaming
// Jmin, dropping I1-I5 and dropping S3/S4 each passed the whole Go suite in
// silence) and this side missed a dropped `H3`.
//
// The vectors are shared and the Go side reads the same file.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAmneziawgClientConfig } from './wgconf.js';

const VECTORS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/shared/testdata/awg-obfuscation-vectors.json',
);

interface Vector {
  name: string;
  params: Record<string, number | string>;
  client: string[];
}

const doc = JSON.parse(readFileSync(VECTORS, 'utf8')) as { vectors: Vector[] };

/** The obfuscation keys, in the order the contract lists them. Everything else
 *  in the file — PrivateKey, Address, DNS, the whole [Peer] block — belongs to
 *  the tunnel's identity rather than to its disguise, and is covered next door
 *  in wgconf.test.ts. */
const OBF = /^(Jc|Jmin|Jmax|S[1-4]|H[1-4]|I[1-5]) = /;

function obfuscationLines(v: Vector): string[] {
  const p = v.params;
  const conf = buildAmneziawgClientConfig({
    privateKey: 'cHJpdmF0ZS1rZXktZm9yLXRoZS1jb250cmFjdC10ZXN0',
    allowedIp: '10.0.0.42/32',
    serverPublicKey: 'cHVibGljLWtleS1mb3ItdGhlLWNvbnRyYWN0LXRlc3Q=',
    host: 'awg.example.com',
    port: 51820,
    jc: p.jc as number,
    jmin: p.jmin as number,
    jmax: p.jmax as number,
    s1: p.s1 as number,
    s2: p.s2 as number,
    s3: p.s3 as number,
    s4: p.s4 as number,
    h1: p.h1 as number,
    h2: p.h2 as number,
    h3: p.h3 as number,
    h4: p.h4 as number,
    i1: p.i1 as string,
    i2: p.i2 as string,
    i3: p.i3 as string,
    i4: p.i4 as string,
    i5: p.i5 as string,
  });
  return conf.split('\n').filter((l) => OBF.test(l));
}

describe('the obfuscation contract with the node agent', () => {
  it('the fixture is there and shaped like a fixture', () => {
    // The control: an empty or reshaped file would make the case below pass by
    // having nothing to compare — and this pair is asymmetric, so the fixture
    // carries a `client` list per vector rather than one shared block.
    expect(doc.vectors.length).toBeGreaterThanOrEqual(2);
    for (const v of doc.vectors) {
      // Nine is the floor, not a round number: Jc/Jmin/Jmax + S1/S2 + H1-H4 is
      // what a 1.x-shaped client block is, with S3/S4 omitted at zero and no
      // mimicry slots used. Anything shorter means the fixture lost a key.
      expect(v.client.length, `${v.name} lists too few client lines`).toBeGreaterThanOrEqual(9);
    }
  });

  it.each(doc.vectors)('$name', (v) => {
    expect(
      obfuscationLines(v),
      'the server half of this tunnel is built from the same contract, and AmneziaWG ' +
        'hashes these into the handshake — a mismatch is a tunnel that never decrypts',
    ).toEqual(v.client);
  });

  // The one deliberate difference between the two sides, asserted where it is
  // decided. The server emits S3/S4 always; this side omits them at zero
  // because the AmneziaVPN iOS network extension cannot parse those keys at
  // all (checked on 4.8.19) and aborts with ParseError 9. Changing it is a
  // decision about which clients keep working.
  it('omits S3/S4 at zero, and emits them when they are real', () => {
    const [zeroCase, twoOh] = doc.vectors;
    expect(obfuscationLines(zeroCase!).some((l) => l.startsWith('S3'))).toBe(false);
    expect(obfuscationLines(zeroCase!).some((l) => l.startsWith('S4'))).toBe(false);
    expect(obfuscationLines(twoOh!)).toContain('S3 = 22');
    expect(obfuscationLines(twoOh!)).toContain('S4 = 16');
  });
});
