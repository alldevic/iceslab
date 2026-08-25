// The message an operator reads when cores are down.
//
// It has one hard budget (200 characters) and two things to fit in it: WHICH
// cores are down, and WHY. The old version joined `name (reason)` pairs and cut
// the result, which spends the whole budget on the first core and drops the
// rest — including the fact that they are down at all.

import { describe, expect, it } from 'vitest';
import { composeDownMessage } from './nodes.cron.js';

// Real shapes: the agent keeps the tail of the core's last line, up to 163
// characters including the ellipsis it adds.
const XRAY_ERR =
  '...app/proxyman/inbound: failed to listen TCP on 8443 > transport/internet: failed to listen on address 0.0.0.0:8443 > bind: address already in use';
const HY_ERR =
  '...failed to load TLS certificate: open /etc/hysteria/cert.pem: no such file or directory';

describe('composeDownMessage', () => {
  it('names every down core even when the reasons cannot all fit', () => {
    const msg = composeDownMessage([
      { name: 'xray', lastError: XRAY_ERR },
      { name: 'hysteria', lastError: HY_ERR },
    ]);
    expect(msg.length).toBeLessThanOrEqual(200);
    // The old message stopped inside hysteria's path and never said it was down.
    expect(msg).toContain('xray');
    expect(msg).toContain('hysteria');
  });

  it('keeps the end of each reason, which is where the cause is', () => {
    const msg = composeDownMessage([
      { name: 'xray', lastError: XRAY_ERR },
      { name: 'hysteria', lastError: HY_ERR },
    ]);
    // xray nests with " > " and Go wraps with ": ", so the last clause is the
    // one an operator acts on. Both survive; before, only xray's did.
    expect(msg).toContain('address already in use');
    expect(msg).toContain('no such file or directory');
  });

  it('marks a trimmed reason instead of passing it off as complete', () => {
    const msg = composeDownMessage([
      { name: 'xray', lastError: XRAY_ERR },
      { name: 'hysteria', lastError: HY_ERR },
    ]);
    expect(msg).toContain('(...');
    // And never doubles the agent's own ellipsis into `......`.
    expect(msg).not.toContain('......');
  });

  it('leaves a short reason exactly as the core said it', () => {
    const msg = composeDownMessage([{ name: 'xray', lastError: 'config parse error at line 4' }]);
    expect(msg).toBe('not running: xray (config parse error at line 4)');
  });

  it('drops the reasons rather than print fragments, when there are many cores', () => {
    const cores = ['xray', 'hysteria', 'mieru', 'naive', 'shadowsocks', 'mtproto'].map((name) => ({
      name,
      lastError: XRAY_ERR,
    }));
    const msg = composeDownMessage(cores);
    expect(msg.length).toBeLessThanOrEqual(200);
    for (const c of cores) expect(msg, `${c.name} went missing`).toContain(c.name);
    // A 20-character shard of a nested error is noise wearing an explanation's
    // clothes; the names alone are the honest message.
    expect(msg).not.toContain('(');
  });

  it('says only the names when the agent reported no reason', () => {
    expect(composeDownMessage([{ name: 'xray' }, { name: 'hysteria' }])).toBe(
      'not running: xray, hysteria',
    );
  });
});
