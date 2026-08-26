// Which port a quick-deploy chip picks, and which one it must never pick.
//
// Both failures are the same shape: the operator clicks deploy, the panel picks
// a port, and the node answers with something that does not read as "that port
// is taken". A second binding on 443 came back as 409 PORT_IN_USE (the reason
// the candidate list exists at all); the node-agent's own mTLS port comes back
// as EADDRINUSE inside the adapter, surfacing as a confusing 500 from
// applyInbounds.

import { describe, expect, it } from 'vitest';
import {
  QUICK_DEPLOY_PORT_CANDIDATES,
  parseNodeAgentPort,
  pickFreeQuickDeployPort,
} from './ports';

describe('parseNodeAgentPort', () => {
  it('reads the port out of a host:port address', () => {
    expect(parseNodeAgentPort('n1.example.com:1337')).toBe(1337);
    expect(parseNodeAgentPort('203.0.113.7:9000')).toBe(9000);
  });

  // lastIndexOf, not indexOf: a bracketed IPv6 literal is full of colons and
  // splitting on the first one yields nothing usable.
  it('reads the port of a bracketed IPv6 address', () => {
    expect(parseNodeAgentPort('[2606:4700::1111]:1337')).toBe(1337);
  });

  // A null here means "no port to exclude", which is the safe direction: the
  // picker simply has one fewer reservation.
  it('answers null for anything without a port', () => {
    expect(parseNodeAgentPort(null)).toBeNull();
    expect(parseNodeAgentPort(undefined)).toBeNull();
    expect(parseNodeAgentPort('')).toBeNull();
    expect(parseNodeAgentPort('n1.example.com')).toBeNull();
    expect(parseNodeAgentPort('n1.example.com:')).toBeNull();
    expect(parseNodeAgentPort('n1.example.com:notaport')).toBeNull();
  });
});

describe('pickFreeQuickDeployPort', () => {
  it('offers 443 first on an empty node', () => {
    expect(pickFreeQuickDeployPort([])).toBe(443);
    expect(QUICK_DEPLOY_PORT_CANDIDATES[0]).toBe(443);
  });

  // The regression the candidate list was added for: before it, the chip
  // hardcoded 443 and the second binding on a node fell over with 409.
  it('walks down the list as ports get taken', () => {
    expect(pickFreeQuickDeployPort([443])).toBe(8443);
    expect(pickFreeQuickDeployPort([443, 8443])).toBe(2053);
    expect(pickFreeQuickDeployPort([443, 8443, 2053])).toBe(2083);
  });

  // The node-agent's own listener. Binding a user protocol to it is EADDRINUSE
  // at adapter start, which reaches the operator as a 500 rather than as a port
  // conflict.
  it('never offers a reserved port', () => {
    expect(pickFreeQuickDeployPort([], [443])).toBe(8443);
    expect(pickFreeQuickDeployPort([8443], [443])).toBe(2053);
    // The real case: an agent installed on 8443 instead of the default 1337.
    expect(pickFreeQuickDeployPort([443], [8443])).toBe(2053);
  });

  it('keeps going past every candidate rather than returning a taken port', () => {
    const all = [...QUICK_DEPLOY_PORT_CANDIDATES];
    const picked = pickFreeQuickDeployPort(all);
    expect(all).not.toContain(picked);
    expect(picked).toBe(Math.max(...all) + 1);
  });

  it('counts reservations when falling back past the list', () => {
    const all = [...QUICK_DEPLOY_PORT_CANDIDATES];
    const picked = pickFreeQuickDeployPort(all, [60000]);
    expect(picked, 'the fallback must clear the reserved port too').toBe(60001);
  });

  // Ports assigned earlier in the same batch are passed in as occupied, so a
  // multi-profile deploy must not hand the same port to two bindings.
  it('gives a different port to each binding in one batch', () => {
    const taken: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const p = pickFreeQuickDeployPort(taken, [1337]);
      expect(taken, `binding ${i} reused a port`).not.toContain(p);
      taken.push(p);
    }
    expect(taken).toEqual([443, 8443, 2053, 2083]);
  });
});
