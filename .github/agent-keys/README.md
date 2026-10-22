# Node agent release keys

The public halves of the two ed25519 keys that sign `SHA256SUMS` of every
release (`.github/workflows/release.yml`, job `agent-sign`). The node agent
trusts these two and nothing else when it checks an update.

- `primary.pub`: signs every release. Its private half is the secret
  `AGENT_SIGNING_KEY` of the `release` environment.
- `backup.pub`: signs nothing in normal times. Its private half never enters
  GitHub; the owner keeps it offline. It signs the one release that replaces a
  leaked primary, so that nodes accept the new key set.

Checking a release by hand:

```
sha256sum -c --ignore-missing SHA256SUMS
openssl pkeyutl -verify -pubin -inkey primary.pub -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
```

A change to either file is a change to what every node will run. It goes
with the agent release that carries the same keys built in.
