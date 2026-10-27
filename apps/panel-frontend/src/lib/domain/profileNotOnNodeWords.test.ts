import { describe, expect, it } from 'vitest';
import { portConflict, profileNotOnNode } from '@/lib/domain/hosts';
import { profileNotOnNodeWords } from '@/lib/domain/profileNotOnNodeWords';

const res = (status: number, data: unknown) => ({ response: { status, data } });
const t = (key: string, vars?: Record<string, unknown>) => `${key}${vars ? ' ' + JSON.stringify(vars) : ''}`;
const body = {
  error: 'PROFILE_DOES_NOT_RUN_ON_NODE',
  message: 'Node "de-1" cannot serve this profile',
  nodeName: 'de-1',
  neededEngine: 'singbox',
  reportedEngines: ['xray', 'hysteria'],
  canWait: false,
};

describe('profileNotOnNode (A-235)', () => {
  it('reads the node, the needed core and what the node reported', () => {
    expect(profileNotOnNode(res(409, body))).toEqual({
      nodeName: 'de-1',
      neededEngine: 'singbox',
      reportedEngines: ['xray', 'hysteria'],
      canWait: false,
    });
  });

  it('another 409, another status or a malformed body is not this refusal', () => {
    expect(profileNotOnNode(res(409, { error: 'PORT_TAKEN_PROFILE' }))).toBeNull();
    expect(profileNotOnNode(res(400, body))).toBeNull();
    expect(profileNotOnNode(res(409, { ...body, reportedEngines: [1] }))).toBeNull();
    expect(profileNotOnNode(res(409, { ...body, neededEngine: undefined }))).toBeNull();
    expect(profileNotOnNode(null)).toBeNull();
  });

  it('portConflict no longer claims it as a port (it reads port codes only)', () => {
    expect(portConflict(res(409, body))).toBeNull();
    expect(profileNotOnNode(res(409, body))).not.toBeNull();
  });
});

describe('profileNotOnNodeWords', () => {
  it('names the needed core and the reported ones; an empty report says «nothing»', () => {
    expect(profileNotOnNodeWords(profileNotOnNode(res(409, body))!, t)).toBe(
      'hostEdit.notOnNode {"node":"de-1","needed":"engine.singbox","reported":"engine.xray, hysteria"}',
    );
    const none = profileNotOnNodeWords({ nodeName: 'x', neededEngine: 'xray', reportedEngines: [], canWait: false }, t);
    expect(none).toContain('hostEdit.notOnNodeNothing');
  });

  it('says waiting helps only when the server says so', () => {
    const w = profileNotOnNodeWords({ nodeName: 'x', neededEngine: 'xray', reportedEngines: [], canWait: true }, t);
    expect(w).toContain('hostEdit.notOnNodeWait');
  });
});
