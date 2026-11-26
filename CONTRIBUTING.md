# Contributing

Iceslab is in alpha. Bug reports and small PRs are welcome. Before sinking time into a large change, open an issue first to check it lines up with where the project is heading.

## Development setup

Requirements: Node 22+, pnpm 10+, Go 1.22+, Docker. Tested on Ubuntu (WSL2 on Windows works).

```bash
pnpm install
docker compose up -d postgres redis postgres-test
pnpm --filter @iceslab/panel-backend exec prisma migrate dev
pnpm --filter @iceslab/panel-backend dev     # backend on :3000
pnpm --filter @iceslab/panel-frontend dev    # SPA on :5173
```

## Branches

- `main` is the release branch: what the installer scripts pull, and where the
  tags (`v0.1.0`, `v0.1.1`, ...) are cut from. Keep it deployable.
- `develop` is where work lands first and gets tested. It publishes rolling
  images to GHCR under the `develop` tag, which is what test servers pull.
- Fork, branch off `develop`, and open your PR back into `develop`. A fix for a
  released bug can target `main` directly; say so in the PR.

## Before opening a PR

Run the checks the CI will run:

```bash
pnpm --filter @iceslab/panel-backend exec tsc --noEmit
pnpm --filter @iceslab/panel-frontend exec tsc -b --noEmit
pnpm --filter @iceslab/panel-backend test
cd apps/node && go build ./... && go test ./...
```

If you touched the wire format between panel and node (`packages/shared/src/transport.ts`), mirror the change in `apps/node/internal/dto/dto.go` with matching `json:` tags. The two sides have no version negotiation; mismatched fields surface as `INVALID_BODY` 400s.

## How we write code

The goal is code that rarely needs touching: a change lands where the requirement changed, and nowhere else.

- **Extend by adding.** A new protocol, client format or check is a new adapter or package plugged into an existing registry, not another branch in a `switch` spread across the codebase.
- **Keep a module's public surface small.** Use another module only through what it exports for others; do not reach into its internals or its tables.
- **Public contracts only grow.** What clients and nodes already read (subscription output, API responses) can gain fields; do not rename or remove one in place. The panel-node wire format has no version negotiation yet, so change both of its sides in the same commit, as described above.
- **Errors are values.** Handle an error or return it with context. No empty `catch`, no `_ = err`. A refusal tells the user what happened and carries a code.
- **No new global state.** Pass dependencies in through constructors.
- **Test through the public surface.** Output formats are covered by golden files; anything an engine accepts silently (`check` passes) is proven by a live test.
- **Mirror tests: how a frontend test gets a backend rule.** The profile form must agree with the API's schemas, and a test, not an operator, finds where it does not. Application code imports no backend module and has no `zod`; a test has four ways in, by the kind of rule:
  - *A list* (`ENGINE_OPTIONS`, `REALITY_TRANSPORTS`, `NETWORKS_CARRYING_VISION`) lives in `packages/shared/src/profile-rules.ts`; the backend validates with it and the frontend imports it, and a mirror test compares the form's own list to it (`profileKinds.test.ts`: `ENGINE_CHOICE_PROTOCOLS`).
  - *A number bound or a pattern* stays in the backend schema file; the frontend test reads that file as text through `backendSource()` / `exportedConst()` in `apps/panel-frontend/src/test-support/backendSource.ts` and compares it to the form's constant (`profileRules.mirror.test.ts`). It is read by a regular expression, so a reformatted or renamed bound fails the test loudly, and is fixed in the test.
  - *Anything that needs the schema to run* (the form's defaults accepted by `CreateProfileSchema`, form to API and back) is a backend test that imports the form's pure functions through the `@/` alias in `apps/panel-backend/vitest.config.ts` (`profiles.form-defaults.test.ts`). Application code never imports the backend; this test imports the frontend.
  - *A form's request against the schema that parses it* (the node, user, squad, host, cascade, SRR rule, settings, named-outbound and node-policy forms) is a frontend test that mounts the form and gives what it sends to the backend's own schema, imported through the `@backend` alias (`vitest.config.ts`, `tsconfig.forms.json`; `zod` is a frontend devDependency). Only a `*.schemas.ts` file and what it imports can be reached this way, and none of it may import prisma, redis or fastify: the `frontend` job generates no client. `src/test-support/backendSchemas.test.ts` checks both, and that every file a schema reaches is in the CI path filter. Tests are in `src/test/*Forms.test.tsx`; the shared helpers are `src/test/formDrive.tsx`.

  To add a mirror, pick the kind above: move the list to shared and import it on both sides, or add a `match()` on the schema text beside the others, or add a kind to the defaults test. A new profile kind or protocol fails the completeness checks until the mirrors cover it. A change to a backend schema file does not run the frontend CI job until that job's path filter includes it; the filter lists `*.schemas.ts` and the files they import.
- **Abstract on the third repetition**, not the first. A little copying is cheaper than the wrong abstraction.
- **Make code easy to delete.** Temporary flags and compatibility branches carry a removal date.

## Commit messages

Lowercase prefix + short description. Examples:

```
fix(awg): default subnet to 10.66.66.0/24 to avoid host-gateway collision
feat(panel): add Mieru protocol support
docs: document Hysteria port-hopping caveats
chore(deps): bump prisma to 7.8
```

Write your own commit messages and PR descriptions, in your own words. Using an
AI assistant to help with the code is fine, but keep its fingerprints out of the
history: no `Co-Authored-By: <assistant>` trailers, no "Generated with ..."
footers, and no machine-generated boilerplate in the PR body. State the problem,
the root cause, and what you changed, concisely. A PR that carries assistant
attribution gets sent back for a clean rewrite before it lands, so starting
clean saves everyone a round trip.

## Reporting bugs

Use https://github.com/icecompany-tech/iceslab/issues/new. Include:

- Iceslab version (tag or commit SHA)
- VPS distro and version
- Protocol involved
- Relevant logs (`journalctl -u iceslab-node`, panel-backend stdout)
- What you tried, what happened, what you expected

For security issues see [SECURITY.md](./SECURITY.md) - don't file public issues for those.

## License

By contributing you agree your changes are licensed under AGPL-3.0-or-later, same as the rest of the project.
