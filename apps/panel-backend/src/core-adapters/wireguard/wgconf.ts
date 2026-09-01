/**
 * Client-side wg-quick config builder for upstream WireGuard.
 *
 * Deliberately separate from the AmneziaWG builder next door rather than a
 * flag on it: the difference is not "some optional lines", it is which
 * parsers accept the output. Fed an AmneziaWG config, stock wireguard-tools
 * (1.0.20210914) answers `Line unrecognized: 'Jc=4'`, `wg setconf` exits 1 and
 * `wg-quick up` deletes the device it had just made - so a single stray `Jc =`
 * costs the whole tunnel, for exactly the clients this format exists for.
 *
 * Output is a plain text blob; WireGuard has no URL form. Subscription
 * generators wrap it in their preferred container (raw .conf file, QR).
 */

export interface WireguardClientConfigOpts {
  /** User's WireGuard private key (base64, 32 bytes). */
  privateKey: string;
  /**
   * IP allocated to this user inside the inbound's subnet, in CIDR /32 form
   * (e.g. "10.77.77.42/32"). Caller should already have appended the suffix.
   */
  allowedIp: string;
  /** Server's WireGuard public key (base64, 32 bytes). */
  serverPublicKey: string;
  /** Public host the client connects to (no port). */
  host: string;
  /** Public UDP port the WireGuard inbound listens on. */
  port: number;
  /**
   * Routes the client tunnels through the VPN. Default `0.0.0.0/0,::/0`
   * (full tunnel). A split-tunnel deployment passes an explicit CIDR list —
   * `AllowedIPs` is the only split mechanism WireGuard has, there is no
   * domain-level routing to fall back on.
   */
  clientAllowedIps?: string[];
  /** Optional DNS pushed to the client. Default empty (client uses system DNS). */
  dns?: string[];
  /**
   * Tunnel name, written as the leading `# Name = ...` comment.
   *
   * wg-quick has no name field, so this comment IS the naming channel: the
   * WG Tunnel parser reads the first header comment starting with `Name` into
   * `Config.name`, and the app prefers it over the file name and over its own
   * fallback — which is `peers[0].host`, i.e. the bare endpoint IP. Clients
   * that don't know the convention skip it: it is a comment, and every
   * wg-quick parser ignores comment lines.
   */
  name?: string;
  /**
   * Preshared key for this peer, when the profile issues them. Omitted or
   * empty writes NO line: `PresharedKey = ` with nothing after it is a parse
   * error for wg-quick, not "no key", and the iOS parser rejects the file
   * outright — the same trap the AmneziaVPN link builder documents for
   * `psk_key`.
   */
  presharedKey?: string;
  /** Persistent keepalive seconds. Default 25, practical for NAT traversal. */
  persistentKeepalive?: number;
}

export function buildWireguardClientConfig(opts: WireguardClientConfigOpts): string {
  const allowed = (opts.clientAllowedIps?.length ? opts.clientAllowedIps : ['0.0.0.0/0', '::/0']).join(', ');
  const lines: string[] = [];

  // Первой строкой и только ей: парсер WG Tunnel читает ИМЕННО первый
  // заголовочный комментарий, всё, что ниже, для имени уже не считается.
  if (opts.name) lines.push(`# Name = ${opts.name}`);
  lines.push('[Interface]');
  lines.push(`PrivateKey = ${opts.privateKey}`);
  lines.push(`Address = ${opts.allowedIp}`);
  if (opts.dns?.length) {
    lines.push(`DNS = ${opts.dns.join(', ')}`);
  }
  lines.push('');
  lines.push('[Peer]');
  lines.push(`PublicKey = ${opts.serverPublicKey}`);
  if (opts.presharedKey) lines.push(`PresharedKey = ${opts.presharedKey}`);
  lines.push(`AllowedIPs = ${allowed}`);
  lines.push(`Endpoint = ${opts.host}:${opts.port}`);
  lines.push(`PersistentKeepalive = ${opts.persistentKeepalive ?? 25}`);

  return lines.join('\n') + '\n';
}
