import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The capture logic behind `preGateEvents`, exercised on fixtures.
 *
 * This is the piece that decides what the contract gate KNOWS, and it is a
 * positional walk over someone else's source: every top-level branch on
 * `event_name` up to the ACTIONABLE_EVENTS gate. That is a real parser with
 * real ways to be wrong - stopping too early, running past the gate, resolving
 * a set to nothing - and the fixture it normally runs against is a shop
 * checkout nobody has in CI.
 *
 * So the script's own python is lifted out of the .mjs and run here against
 * miniature dispatchers. Lifted, not copied: a second copy of the extraction
 * would drift from the one that actually produces the fixture, and then this
 * file would be testing something nothing runs.
 */

const SCRIPT = new URL('../../../scripts/refresh-minishop-contract.mjs', import.meta.url);

/** The script's embedded python, with the shop path substituted and the final
 *  print (which needs the shop's importable registry) replaced by ours. */
function captureFrom(services: string): string[] {
  const src = readFileSync(SCRIPT, 'utf8');
  const py = src.split('const PY = `')[1]!.split('\n`;')[0]!;
  const body = py
    .split('import ast, os')[1]!
    .split("print(json.dumps({'operations'")[0]!
    .replace('${JSON.stringify(services)}', JSON.stringify(services));
  const program = `import ast, os, json\n${body}\nprint(json.dumps(_pre_gate_events()))\n`;
  return JSON.parse(execFileSync('python3', ['-c', program], { encoding: 'utf8' }));
}

/** A dispatcher shaped like the shop's: pre-gate branches, then the gate. */
function shop(opts: { hwid?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'shopfix-'));
  writeFileSync(
    join(dir, 'torrent_blocker_webhook.py'),
    'TORRENT_BLOCKER_EVENT = "torrent_blocker.report"\n',
  );
  if (opts.hwid) {
    writeFileSync(
      join(dir, 'hwid_device_webhook.py'),
      [
        'HWID_DEVICE_ADDED_EVENT = "user_hwid_devices.added"',
        'HWID_DEVICE_DELETED_EVENT = "user_hwid_devices.deleted"',
        'HWID_DEVICE_EVENTS = frozenset({HWID_DEVICE_ADDED_EVENT, HWID_DEVICE_DELETED_EVENT})',
        '',
      ].join('\n'),
    );
  }
  writeFileSync(join(dir, 'panel_webhook_payloads.py'), 'ACTIONABLE_EVENTS = frozenset({"user.expired"})\n');
  writeFileSync(
    join(dir, 'panel_webhook_service.py'),
    [
      'from .torrent_blocker_webhook import TORRENT_BLOCKER_EVENT',
      opts.hwid ? 'from .hwid_device_webhook import HWID_DEVICE_ADDED_EVENT, HWID_DEVICE_EVENTS' : '',
      'from .panel_webhook_payloads import ACTIONABLE_EVENTS',
      'EVENT_MAP = {"user.expires_in_24_hours": 1}',
      '',
      'class PanelWebhookService:',
      '    def dispatch(self, event_name, user_payload, context=None):',
      '        if event_name == TORRENT_BLOCKER_EVENT:',
      '            return self.torrent(user_payload)',
      opts.hwid ? '        if event_name == HWID_DEVICE_ADDED_EVENT:' : '',
      opts.hwid ? '            return self.hwid_added(user_payload)' : '',
      '        if event_name not in ACTIONABLE_EVENTS:',
      '            return None',
      '        if event_name == "user.after_the_gate":',
      '            return self.late(user_payload)',
      '        return self.notify(user_payload)',
      '',
      '    def stages(self, event_name):',
      '        if event_name in EVENT_MAP:',
      '            return EVENT_MAP[event_name]',
      '        return None',
      '',
      // The trap the real shop sets, reproduced: a method that touches BOTH
      // hwid events but never reaches the gate, because it only normalises a
      // payload. A walk that collects from every function - or from the
      // frozenset it names - reports `.deleted` as handled.
      opts.hwid ? '    def context_for(self, event_name, data):' : '',
      opts.hwid ? '        if event_name in HWID_DEVICE_EVENTS:' : '',
      opts.hwid ? '            return self.normalise(data)' : '',
      opts.hwid ? '        return None' : '',
      opts.hwid ? '' : '',
    ].filter((l) => l !== '').join('\n'),
  );
  return dir;
}

describe('what the contract capture reads off a shop dispatcher', () => {
  it('finds the branches above the gate, and stops at it', () => {
    // `user.after_the_gate` sits BELOW the gate: it is reached only for events
    // already in ACTIONABLE_EVENTS, so counting it would claim the shop handles
    // things it drops. The fixture carries it precisely so a walk that runs past
    // the gate is caught, rather than looking correct on a shop that has no such
    // branch.
    expect(captureFrom(shop())).toEqual(['torrent_blocker.report']);
  });

  it('picks up a newer shop’s hwid branch without being told about it', () => {
    expect(captureFrom(shop({ hwid: true }))).toEqual([
      'torrent_blocker.report',
      'user_hwid_devices.added',
    ]);
  });

  it('leaves out the hwid event the dispatcher only normalises', () => {
    // The distinction the whole decision rests on. `HWID_DEVICE_EVENTS` holds
    // BOTH names and the shop does touch `.deleted` - it normalises the payload
    // and builds an idempotency key for it - but it never branches on it, so
    // nothing happens. A capture keyed on that frozenset instead of on the
    // dispatcher's branches would report `.deleted` as handled and authorise us
    // to send an event that does nothing.
    expect(captureFrom(shop({ hwid: true }))).not.toContain('user_hwid_devices.deleted');
  });

  it('refuses to guess when a branch names something it cannot resolve', () => {
    // A silently shortened set makes the gate assert less while still passing -
    // the same failure the ACTIONABLE_EVENTS reader already guards against.
    const dir = shop();
    const path = join(dir, 'panel_webhook_service.py');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        'if event_name == TORRENT_BLOCKER_EVENT:',
        'if event_name == SOME_EVENT_WE_CANNOT_SEE:',
      ),
    );
    expect(() => captureFrom(dir)).toThrow(/cannot resolve/);
  });
});
