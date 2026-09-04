import { createHash } from 'node:crypto';

import { config } from '../../config.js';

/**
 * Credentials for the local socks/http listeners the xray-json document binds
 * on the buyer's device (3.15).
 *
 * Why they exist. Those listeners live on 127.0.0.1, and on Android loopback is
 * not isolated per app: any installed app can open 10808/10809 and ride the
 * buyer's tunnel — spending their quota, leaving from their address, and (the
 * documented abuse) linking a web identity to an app one. Credentials work here
 * for a specific reason: the config sits inside the VPN client's sandbox, so an
 * app that can reach the port still cannot read the password.
 *
 * Why derived rather than stored. Nothing to migrate, nothing to leak from a
 * dump, and the pair follows the subscription token — which is the right
 * lifetime, because rotating the token already forces every client to re-fetch
 * the document. A stored column would have to be rotated by hand and would
 * outlive the token it protects.
 *
 * Why two hashes rather than one split in half. The username travels in the
 * clear inside the config and shows up in client logs; deriving it from a
 * different prefix keeps it from being a prefix of the password.
 *
 * Not a secret against whoever holds the document: they hold the tunnel too.
 * The threat model is the neighbouring app, which holds neither.
 */
export function localProxyCredentials(token: string): { user: string; pass: string } {
  const digest = (kind: string, len: number): string =>
    createHash('sha256')
      .update(`local-proxy-${kind}:${config.JWT_SECRET}:${token}`)
      .digest('hex')
      .slice(0, len);
  return { user: digest('user', 12), pass: digest('pass', 24) };
}
