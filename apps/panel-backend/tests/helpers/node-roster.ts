import { vi } from 'vitest';
import type { AddUserRequest, AddUsersRequest } from '@iceslab/shared';
import { NodeTransport } from '../../src/modules/nodes/nodes.transport.js';

/**
 * The roster half of a push, answered here (A-112).
 *
 * A test that stubs only applyInbounds lets the user list after it go out as a
 * real /addUsers to a node with no address behind it, which waits out its
 * 60 s timeout. Called beside every applyInbounds stub, so the push never
 * leaves the process. Answers ok for every user; returns what was sent.
 */
export function stubNodeRoster(): { batches: AddUsersRequest[]; singles: AddUserRequest[] } {
  const batches: AddUsersRequest[] = [];
  const singles: AddUserRequest[] = [];
  vi.spyOn(NodeTransport.prototype, 'addUsers').mockImplementation(async (req) => {
    batches.push(req);
    return { results: req.users.map((u) => ({ userId: u.userId, ok: true })) };
  });
  vi.spyOn(NodeTransport.prototype, 'addUser').mockImplementation(async (req) => {
    singles.push(req);
  });
  return { batches, singles };
}
