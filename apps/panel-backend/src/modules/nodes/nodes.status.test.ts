import { describe, expect, it } from 'vitest';
import { statusFromHealth, tuneWorthWriting } from './nodes.cron.js';

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
describe('statusFromHealth carries the reason a core is down', () => {
  it('names the core AND why, when the agent says why', () => {
    // `not running: xray` is true and useless. The reason sat in the node's
    // journal, on a machine the operator has to go and find, and nothing tied
    // the crash to the profile they had just saved. Reproduced live: a listen
    // port already taken gave sixteen crashes and a message that stopped at the
    // core's name.
    const r = statusFromHealth({
      status: 'degraded',
      cores: [
        {
          name: 'xray',
          running: false,
          lastError: 'Failed to start: ... bind: address already in use',
        },
      ],
    });
    expect(r.status).toBe('degraded');
    expect(r.message).toContain('xray');
    expect(r.message).toContain('address already in use');
  });

  it('says only the name when the agent offers no reason', () => {
    // An agent predating the field sends nothing, and inventing a parenthesis
    // with nothing in it would read as an explanation that failed to load.
    const r = statusFromHealth({
      status: 'degraded',
      cores: [{ name: 'xray', running: false }],
    });
    expect(r.message).toBe('not running: xray');
  });

  it('does not quote a healthy core, whatever it last printed', () => {
    // The control. A running core's last line is ordinary output; repeating it
    // in a status message would report a fault that is not there. This is also
    // what fails if the reason is read off every core rather than the down ones.
    const r = statusFromHealth({
      status: 'degraded',
      cores: [
        { name: 'xray', running: true, lastError: 'accepted tcp:example.com:443' },
        { name: 'hysteria', running: false },
      ],
    });
    expect(r.message).toBe('not running: hysteria');
  });

  it('keeps the message inside the column it is stored in', () => {
    // The truncation this shares with the pre-existing cap: four nodes of the
    // field fleet once stored a message that ended mid-JSON, and a cut-off
    // explanation still looks like an explanation.
    const r = statusFromHealth({
      status: 'degraded',
      cores: [{ name: 'xray', running: false, lastError: 'x'.repeat(500) }],
    });
    expect(r.message!.length).toBeLessThanOrEqual(200);
  });
});

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

// F3: a self-tuning node reports which DPI-bypass strategy it settled on, and
// the panel records it. Every poll re-reports the same strategy, so the write
// has to be keyed on the strategy changing, not on the report arriving.
describe('tuneWorthWriting', () => {
  const tune = {
    domain: 'rutracker.org',
    protocol: 'HTTPS/TLS1.3',
    args: '--payload=tls_client_hello --lua-desync=tcpseg',
    total: 42,
    working: 3,
    observedAt: '2026-08-23T10:00:00.000Z',
  };

  it('writes the first report', () => {
    expect(tuneWorthWriting(null, tune)).toBe(true);
  });

  // Otherwise every 30-second poll rewrites the row for a stamp nobody reads.
  it('does not write the same strategy re-reported later', () => {
    expect(tuneWorthWriting(tune, { ...tune, observedAt: '2026-08-23T11:00:00.000Z' })).toBe(false);
  });

  it('writes when the node changed its mind about how to get through', () => {
    expect(tuneWorthWriting(tune, { ...tune, args: '--payload=tls_client_hello --lua-desync=fake' })).toBe(
      true,
    );
  });

  // The counts are the difference between "nothing is blocked here" and "we
  // could not find anything that works", which is what an operator acts on.
  it('writes when the scan outcome changed', () => {
    expect(tuneWorthWriting(tune, { ...tune, working: 0 })).toBe(true);
    expect(tuneWorthWriting(tune, { ...tune, domain: 'another.example' })).toBe(true);
  });
});
