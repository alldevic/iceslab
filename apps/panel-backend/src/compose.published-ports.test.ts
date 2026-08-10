import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * A published port cannot be taken back by the firewall.
 *
 * Docker installs its port publishing as DNAT in `nat/PREROUTING`, which runs
 * before ufw's filter chains. So `ufw status` can show a port as closed while
 * the whole internet reaches it, and no amount of `ufw deny` changes that. The
 * bind address in the port mapping is the only control there is.
 *
 * That is not theory. Until 2026-08-10 the panel SPA was published as
 * `${FRONTEND_PORT}:80`, i.e. on every interface. On a domain install the
 * installer put Caddy in front, skipped opening the port in ufw, and reported
 * "default deny incoming" - while the admin UI answered plain HTTP on :8080 to
 * anyone who scanned for it, login password included. It surfaced through a
 * community install report (issue #33) and was then reproduced against our own
 * panel: HTTP 200 from the public internet on a port ufw did not list.
 *
 * This test pins the shape of every published port in the production compose
 * files: each one must name the address it binds to. Choosing 0.0.0.0 stays
 * possible - it is the right answer for a bare-IP install - but it has to be
 * chosen out loud, in a variable an operator can see, rather than inherited
 * from a default nobody read.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const COMPOSE_FILES = ['docker-compose.prod.yml', 'docker-compose.ghcr.yml'];

/** `- "127.0.0.1:8080:80"` / `- "${FRONTEND_BIND:-127.0.0.1}:${FRONTEND_PORT:-8080}:80"` */
const PUBLISHED_PORT = /^\s*-\s*"([^"]+)"\s*$/;

/**
 * Split a mapping into its colon-separated parts, ignoring the colons INSIDE
 * `${VAR:-default}`.
 *
 * Without this the check is worse than useless: `${FRONTEND_PORT:-8080}:80`
 * looks like three parts to a naive split, so the exact regression this test
 * exists to catch sails straight through it. Verified by putting the old
 * mapping back and watching the test stay green.
 */
function segments(mapping: string): string[] {
  return mapping.replace(/\$\{[^}]*\}/g, 'X').split(':');
}

function publishedPorts(text: string): string[] {
  const lines = text.split('\n');
  const found: string[] = [];
  let insidePorts = false;
  let portsIndent = 0;

  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;

    if (/^\s*ports:\s*$/.test(line)) {
      insidePorts = true;
      portsIndent = indent;
      continue;
    }
    if (!insidePorts) continue;

    // A comment inside the block, or a list entry, keeps us in it; anything at
    // the same or lower indentation ends it.
    if (line.trimStart().startsWith('#')) continue;
    if (indent <= portsIndent) {
      insidePorts = false;
      continue;
    }
    const match = PUBLISHED_PORT.exec(line);
    if (match?.[1]) found.push(match[1]);
  }
  return found;
}

describe('production compose files', () => {
  for (const file of COMPOSE_FILES) {
    it(`${file}: every published port names its bind address`, () => {
      const text = readFileSync(resolve(repoRoot, file), 'utf8');
      const ports = publishedPorts(text);

      // Guard the guard: if the parser stops finding anything, this test would
      // pass vacuously forever.
      expect(ports.length, `no published ports parsed out of ${file}`).toBeGreaterThan(0);

      const unbound = ports.filter((mapping) => segments(mapping).length < 3);
      expect(
        unbound,
        `These mappings publish on every interface. Docker DNATs them before ufw ` +
          `sees the packet, so the firewall cannot close them afterwards:\n  ` +
          `${unbound.join('\n  ')}\n` +
          `Write them as "<bind>:<host port>:<container port>", e.g. ` +
          `"\${FRONTEND_BIND:-127.0.0.1}:\${FRONTEND_PORT:-8080}:80".`,
      ).toEqual([]);
    });

    it(`${file}: the panel UI is not exposed to the world by default`, () => {
      const text = readFileSync(resolve(repoRoot, file), 'utf8');
      const ports = publishedPorts(text);
      const worldByDefault = ports.filter((mapping) => /^(0\.0\.0\.0|\$\{[^}]*:-0\.0\.0\.0\})/.test(mapping));
      expect(
        worldByDefault,
        `Defaulting a bind address to 0.0.0.0 puts the admin UI on the internet ` +
          `over plain HTTP for anyone who installs without reading:\n  ` +
          `${worldByDefault.join('\n  ')}`,
      ).toEqual([]);
    });
  }
});
