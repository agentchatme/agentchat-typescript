# Releasing `agentchatme`

Releases ship only through `.github/workflows/publish.yml`: npm trusted publishing (OIDC) behind a human approval, with provenance attached. Never `npm publish` from a machine. No npm token exists anywhere: the account's security-key 2FA makes every token type ask for a one-time password, by design.

## A release

1. **The number.** The founder sets it, per [VERSIONING.md](./VERSIONING.md).
2. **The release PR**, from `main`: the `version` in `package.json` (the only place it lives; the build injects it as `VERSION` and into the User-Agent) and a CHANGELOG section `## <version> — <date>`. CI green, merged.
3. **The tag**, on the merge commit on `main`:
   ```bash
   git fetch origin && git checkout origin/main
   node -p "require('./package.json').version"   # must print <version>
   git tag v<version> && git push origin v<version>
   ```
   The tag must be exactly `v` + the `package.json` version. `publish.yml` publishes whatever `package.json` says and does not compare it with the tag, so check it before pushing.
4. **The gate.** The tag push starts `publish.yml`. Its `test` job repeats the full CI gate on the tagged commit (Node 20 and 22: frozen install, `pnpm audit --prod --audit-level high`, type-check, tests, build). The `publish` job then waits at the `npm-publish` environment, and `notify-awaiting-tap` posts the run link to the Slack warning channel.
5. **The approval.** The approver taps **Approve and deploy**: `npm publish --access public` runs with OIDC, and npm attaches provenance. A red gate, a rejection or no approval publishes nothing; any red job posts `notify-failure` to the same channel.
6. **The check.** `npm view agentchatme version` shows the number, and the package page's provenance points at the tagged commit.

## Other targets (Actions → Publish to npm → Run workflow)

- **`test`**: publishes the dispatched commit under the `next` dist-tag, for an install check before a structural change ships. It is a real, public publish, and npm never reuses a number: use it only with a pre-release number in `package.json` (`1.4.0-rc.1`).
- **`prod`**: publishes the dispatched commit to `latest`, behind the same approval. For finishing a release whose tag run failed for a reason outside the code (the commit must be the tagged one).
- **`stage-proof`**: see below.

## New-package checklist (one-time per package)

- Copy this repo's `.github/workflows/publish.yml` shape: gate job → `environment: npm-publish` + `id-token: write` → `npm install -g npm@latest` → `npm publish`.
- Create the `npm-publish` environment with the required reviewer (repo Settings → Environments, or the API).
- `package.json` `repository.url` must exactly match the GitHub repo — npm checks it.
- npmjs.com → package Settings → Trusted Publisher: owner `agentchatme`, the repo name, workflow `publish.yml` (bare filename, no path), environment `npm-publish`, tick **npm publish** under allowed actions. Complete the security-key prompt and confirm a **saved summary card** renders — npm silently discards unconfirmed saves and only validates at publish time (mismatches surface as E404 on PUT).
- After the package's first successful gated release: set Publishing access to **"Require two-factor authentication and disallow tokens"** (trusted publishing keeps working; stolen tokens become useless).

## Proving a pairing without publishing (stage-proof)

To validate the trusted-publisher pairing + OIDC + gate WITHOUT a public release
(e.g. onboarding a new package, or after a repo rename), run the publish workflow
via `workflow_dispatch` with `target=stage-proof`. It stages a throwaway
`-proof.N` prerelease through the real trust path (never public), approval-gated
like any release. A green run = the pairing works. Reject the staged version on
npmjs.com afterwards (package → Stages → Reject; requires your 2FA). Packages with
a version-drift guard test stage with `--ignore-scripts` (the gate job already ran
the full suite on the real commit).
