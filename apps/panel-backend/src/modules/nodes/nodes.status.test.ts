import { describe, expect, it } from 'vitest';
import { statusFromHealth } from './nodes.cron.js';

/**
 * A node's status has to answer "is this serving anybody", not just "did the
 * agent pick up the phone".
 *
 * On 2026-08-15 a cascade entry's core was dead for hours: rejected config,
 * five crash restarts, then the supervisor left it down. The panel showed the
 * card green the whole time, because the agent was answering and the status
 * only ever had two values. The detail existed - the poller already wrote
 * "not running: xray" into the message - but a message nobody reads is not a
 * status.
 *
 * `degraded` deliberately does NOT mean "stop serving it": the subscription's
 * liveness filter keys on `unreachable`, so the node keeps handing out its
 * working endpoints, and the poller's re-push includes it, because a core that
 * will not start is exactly the one waiting for a config it can load. Those two
 * rules live at their call sites in nodes.cron / subscription.service.
 */
describe('statusFromHealth', () => {
  it('is online when the agent says everything runs', () => {
    expect(statusFromHealth({ status: 'ok', cores: [] })).toEqual({
      status: 'online',
      message: null,
    });
  });

  it('is degraded when a configured core is not running, and names it', () => {
    // The regression: this used to come back 'online' with the detail buried in
    // a message, so the node list showed green while the proxy served nobody.
    const v = statusFromHealth({
      status: 'degraded',
      cores: [
        { name: 'xray', running: false, provisioned: true },
        { name: 'shadowsocks', running: true, provisioned: true },
      ],
    });
    expect(v.status).toBe('degraded');
    expect(v.message).toBe('not running: xray');
  });

  it('names every core that is down, not just the first', () => {
    const v = statusFromHealth({
      status: 'degraded',
      cores: [
        { name: 'xray', running: false, provisioned: true },
        { name: 'hysteria', running: false, provisioned: true },
      ],
    });
    expect(v.message).toBe('not running: xray, hysteria');
  });

  it('does not blame a core nobody configured', () => {
    // A fresh node registers every adapter it could serve; an unprovisioned one
    // is idle by design, and "not running: mieru" would read as an outage on a
    // node that is simply waiting for its first binding.
    //
    // With nothing to name, the raw answer is kept instead - so assert on the
    // accusation, not on the string as a whole (the payload mentions the core
    // because it is the agent's own words).
    const v = statusFromHealth({
      status: 'degraded',
      cores: [{ name: 'mieru', running: false, provisioned: false }],
    });
    expect(v.message).not.toContain('not running: mieru');
  });

  it('treats a core with no provisioned flag as configured', () => {
    // An agent older than that field. Reading absence as "unconfigured" would
    // silently stop reporting real outages on the nodes least likely to be
    // updated.
    const v = statusFromHealth({
      status: 'degraded',
      cores: [{ name: 'xray', running: false }],
    });
    expect(v.message).toBe('not running: xray');
  });

  it('keeps the raw answer when the agent is unhappy but names no core', () => {
    // The one case where we cannot say what is wrong in advance, so the payload
    // is the message rather than a confident-sounding guess.
    const v = statusFromHealth({ status: 'degraded', cores: [] });
    expect(v.status).toBe('degraded');
    expect(v.message).toContain('degraded:');
  });
});
