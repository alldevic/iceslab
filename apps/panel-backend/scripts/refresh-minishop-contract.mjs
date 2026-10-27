#!/usr/bin/env node
/**
 * Re-capture the minishop's outbound API contract into the pinned fixture the
 * facade is tested against.
 *
 *   node scripts/refresh-minishop-contract.mjs <path-to-minishop-checkout>
 *
 * The shop keeps a machine-readable registry of every Remnawave call it can
 * make (backend/bot/services/panel_api_contracts.py, "the source of truth for
 * every outbound Remnawave request"), so what our facade must serve is a fact
 * we can READ rather than a reading of Python we have to redo by hand each
 * release. This script imports that module with stock python3 - it depends on
 * nothing but the stdlib - and writes the result next to the test.
 *
 * The fixture is pinned, not fetched at test time: a gate that reaches into
 * another repository passes or fails on whatever that repository happened to
 * be, and stops being a statement about our code.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const shop = process.argv[2];
if (!shop) {
  console.error('usage: refresh-minishop-contract.mjs <path-to-minishop-checkout>');
  process.exit(2);
}
const services = resolve(shop, 'backend/bot/services');
const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/modules/remnawave-compat/contracts/minishop-contract.json',
);

const git = (...args) => execFileSync('git', ['-C', shop, ...args], { encoding: 'utf8' }).trim();

const PY = `
import sys, json
sys.path.insert(0, ${JSON.stringify(services)})
import panel_api_contracts as c
ops = [{f: getattr(k, f) for f in k.__slots__} for k in c.PANEL_API_OPERATION_CONTRACTS]
hooks = [{f: getattr(k, f) for f in k.__slots__} for k in c.PANEL_WEBHOOK_CONTRACTS]

# ACTIONABLE_EVENTS is the set the shop's dispatcher acts on; anything else it
# receives is dropped ("elif event_name not in ACTIONABLE_EVENTS"). Read with
# ast rather than imported: panel_webhook_payloads uses relative imports and
# pulls in the bot's dependency tree, none of which is needed to read a literal.
import ast, os
def _consts(path):
    out = {}
    for node in ast.parse(open(path).read()).body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    out[t.id] = node.value.value
    return out

base = ${JSON.stringify(services)}
SOURCES = (
    'torrent_blocker_webhook.py',
    'hwid_device_webhook.py',
    'panel_webhook_payloads.py',
    'panel_webhook_service.py',
)
consts = {}
for f in SOURCES:
    fp = os.path.join(base, f)
    if os.path.exists(fp):
        consts.update(_consts(fp))


def _set_consts():
    # frozenset({NAME, ...}) at module level, resolved through consts. The
    # dispatcher branches on one of these (HWID_DEVICE_EVENTS), so a set that
    # cannot be resolved would silently shorten what we capture.
    out = {}
    for f in SOURCES:
        fp = os.path.join(base, f)
        if not os.path.exists(fp):
            continue
        for node in ast.parse(open(fp).read()).body:
            if not (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)):
                continue
            if getattr(node.value.func, 'id', '') != 'frozenset' or not node.value.args:
                continue
            elts = getattr(node.value.args[0], 'elts', None) or []
            vals = []
            for el in elts:
                if isinstance(el, ast.Constant):
                    vals.append(el.value)
                elif isinstance(el, ast.Name) and el.id in consts:
                    vals.append(consts[el.id])
            for t in node.targets:
                if isinstance(t, ast.Name):
                    out[t.id] = vals
    return out


def _pre_gate_events():
    '''Events the dispatcher ACTS ON before reaching the ACTIONABLE_EVENTS gate.

    The gate is not the whole truth about what the shop handles, and reading it
    as if it were is a modelling error our own contract test used to make: the
    torrent-blocker event has never been in ACTIONABLE_EVENTS and has always had
    its own branch above it. Newer shops added HWID device events the same way.

    Read positionally - every top-level if on event_name UP TO the gate - so
    what is captured is what the dispatcher actually branches on. That
    distinction matters: a dev shop normalizes both user_hwid_devices events but
    branches only on .added, and .deleted correctly does NOT appear here.
    '''
    sets = _set_consts()
    path = os.path.join(base, 'panel_webhook_service.py')
    if not os.path.exists(path):
        return []
    found = []
    for fn in ast.walk(ast.parse(open(path).read())):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        acc, unresolved, reached_gate = [], [], False
        for stmt in fn.body:
            if not isinstance(stmt, ast.If) or not isinstance(stmt.test, ast.Compare):
                continue
            test = stmt.test
            comp, op = test.comparators[0], test.ops[0]
            if isinstance(op, ast.NotIn) and getattr(comp, 'id', '') == 'ACTIONABLE_EVENTS':
                reached_gate = True
                break
            if not str(getattr(test.left, 'id', '')).startswith('event_name'):
                continue
            if isinstance(op, ast.Eq) and isinstance(comp, ast.Constant):
                acc.append(comp.value)
            elif isinstance(op, ast.Eq) and isinstance(comp, ast.Name):
                # Unresolvable names are collected, not raised on: this walk
                # visits every function in the module, and the ones that are not
                # the dispatcher branch on things (EVENT_MAP and friends) we have
                # no business resolving. Refusing to guess still matters, so the
                # complaint is raised below - once we know it was the dispatcher.
                (acc if comp.id in consts else unresolved).append(
                    consts.get(comp.id, comp.id)
                )
            elif isinstance(op, ast.In) and isinstance(comp, ast.Name):
                if comp.id in sets:
                    acc.extend(sets[comp.id])
                else:
                    unresolved.append(comp.id)
        # Only a function that actually reaches the gate is the dispatcher.
        if not reached_gate:
            continue
        if unresolved:
            raise SystemExit(
                'cannot resolve in the dispatcher: ' + ', '.join(sorted(set(unresolved)))
                + ' - a silently shortened set makes the gate assert less while still passing'
            )
        found.extend(acc)
    return sorted(set(found))

tree = ast.parse(open(os.path.join(base, 'panel_webhook_payloads.py')).read())
actionable = None
for node in ast.walk(tree):
    if isinstance(node, ast.Assign) and any(getattr(t, 'id', None) == 'ACTIONABLE_EVENTS' for t in node.targets):
        call = node.value
        if not (isinstance(call, ast.Call) and getattr(call.func, 'id', '') == 'frozenset'):
            raise SystemExit('ACTIONABLE_EVENTS is no longer frozenset(...) - update this script')
        items = []
        for el in call.args[0].elts:
            if isinstance(el, ast.Constant):
                items.append(el.value)
            elif isinstance(el, ast.Name):
                # A named constant; refuse to guess if it cannot be resolved,
                # because a silently shortened set makes the gate assert less
                # while still passing.
                if el.id not in consts:
                    raise SystemExit(f'cannot resolve {el.id} in ACTIONABLE_EVENTS')
                items.append(consts[el.id])
            else:
                raise SystemExit(f'unexpected element in ACTIONABLE_EVENTS: {ast.dump(el)}')
        actionable = sorted(items)
if actionable is None:
    raise SystemExit('ACTIONABLE_EVENTS not found in panel_webhook_payloads.py')

print(json.dumps({'operations': ops, 'webhooks': hooks, 'actionableEvents': actionable, 'preGateEvents': _pre_gate_events()}, default=str))
`;

const dumped = JSON.parse(execFileSync('python3', ['-c', PY], { encoding: 'utf8' }));
const doc = {
  source: {
    repo: git('remote', 'get-url', 'origin'),
    describe: git('describe', '--tags', '--always'),
    commit: git('rev-parse', 'HEAD'),
    committed: git('log', '-1', '--format=%ad', '--date=short'),
  },
  ...dumped,
};
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(
  `wrote ${out}\n  ${doc.operations.length} operations, ${doc.webhooks.length} webhooks, ` +
    `${doc.actionableEvents.length} actionable events, ` +
    `${doc.preGateEvents.length} handled before the gate` +
    `\n  from ${doc.source.describe} (${doc.source.commit.slice(0, 8)}, ${doc.source.committed})`,
);
