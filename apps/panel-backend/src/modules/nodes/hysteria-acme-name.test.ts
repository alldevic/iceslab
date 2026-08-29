// The name the install command tells hysteria to get a certificate for.
//
// `acmeHostnameFor` is where the rule lives and says why: an IP literal is not
// served by Let's Encrypt, a single-label name cannot be publicly resolvable.
// Both bootstrap-command renderers used `address.split(':')[0]` instead, so a
// node registered by IP — every node before somebody points DNS at it — got
// `--hysteria-domain <the IP>`.
//
// Measured on a Debian 13 guest 2026-08-29, running the panel's own
// copy-pasted command:
//
//   FATAL failed to load server config  {"error": "invalid config:
//     acme.domains: 127.0.0.1: obtaining certificate: [127.0.0.1] Obtain:
//     subject '127.0.0.1' does not qualify for a public certificate"}
//   hysteria.service: Failed with result 'exit-code'.
//
// ...while the installer printed its success banner, because its last step asks
// about the AGENT and the agent was fine. Two renderers, one guard — and the
// guard was in neither.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acmeHostnameFor } from '../inbounds/inbounds.queue.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Source with comments cut out: a mirror that reads them answers about prose. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const RENDERERS = ['nodes.service.ts', 'nodes.routes.ts'];

describe('the hysteria ACME name in a bootstrap command', () => {
  it('is refused by acmeHostnameFor for everything a CA will not issue', () => {
    expect(acmeHostnameFor('127.0.0.1:1337')).toBeNull();
    expect(acmeHostnameFor('203.0.113.10:1337')).toBeNull();
    expect(acmeHostnameFor('localhost:1337')).toBeNull();
    expect(acmeHostnameFor('[2001:db8::1]:1337')).toBeNull();
    // ...and allowed for the one shape that can carry a certificate.
    expect(acmeHostnameFor('node.example.com:1337')).toBe('node.example.com');
  });

  it('comes from that function in BOTH renderers, not from splitting the address', () => {
    // Read off the source: the failure is a renderer computing the name its own
    // way, and no request would reveal it — the command is a string an operator
    // pastes somewhere else.
    for (const file of RENDERERS) {
      const src = code(resolve(HERE, file));
      // The control: a file that stopped rendering the flag at all would pass
      // the negative check below while saying nothing.
      expect(src, `${file} no longer renders --hysteria-domain`).toContain('--hysteria-domain');
      expect(
        src,
        `${file} still derives the ACME name by splitting the address; acmeHostnameFor exists precisely because that answer is wrong for an IP`,
      ).toContain('acmeHostnameFor(nodeAddress)');
    }
  });

  it('and each renderer says so in the command when the address cannot carry one', () => {
    // Silence reads as "nothing else to do", and hysteria would simply never
    // come up. The operator is looking at the command, so the sentence goes
    // there.
    for (const file of RENDERERS) {
      const src = code(resolve(HERE, file));
      expect(src, `${file} drops the flag silently for an IP-addressed node`).toContain(
        'hysteria needs a public FQDN',
      );
    }
  });
});
