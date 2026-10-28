# WIHM Installer

A Persian local-browser installer. Runtime dependency: Node.js 22+. No npm install, Wrangler, workerd, native extensions or Git on the end user's device. `install.ps1` and `install.sh` prepare Node if needed; Termux uses its own `nodejs-lts` package instead of a desktop Linux binary.

Build from the repository root:

```sh
npm ci
npm run installer:build
node scripts/check-installer.mjs
npm run installer:start
```

The distributable is `dist/WIHM-Installer`. CI builds ZIP and tar.gz archives and SHA-256 checksums. A tag named `installer-v*` publishes them after Windows, macOS and Linux checks pass. Package and tag versions must agree. Build metadata, the installer footer and release title derive from the package version. Keep `src/version.ts`, the messenger version label and its Service Worker cache version aligned; include `docs/releases/<version>.fa.md`. Bootstrap launchers download the latest stable package, while an already-extracted old package remains that old version.

`cloudflare.mjs` uses the fixed official API origin and never displays raw provider error text. `deploy.mjs` checks ownership, prepares a workers.dev address, creates or reuses D1, initializes the additive schema, applies versioned SQL migrations, uploads Static Assets, uploads the precompiled Worker with its initial SQLite Durable Object migration, and enables the public address. Updating an installer-managed Worker inherits `JWT_SECRET` using strict binding inheritance; it does not regenerate the secret or replay the initial Durable Object migration. SQL migrations are recorded in `schema_migrations` and must be replay-safe if a response is lost. Unrecognized Workers or databases are refused. The 1.0 ownership marker is accepted for upgrading; the new marker deliberately makes 1.0 installers refuse an upgraded Worker, preventing accidental downgrade. Manually installed instances need a future explicit migration path.

`server.mjs` binds only to `127.0.0.1` on a random port. A random session key in the initial URL fragment authorizes API requests; it is removed from the visible URL and retained in tab session storage. Host, Origin and fetch-site checks restrict browser access. API credentials stay in the server process's memory. Stopping the installer drops credentials. The on-disk recovery journal contains only database identifiers, scoped by account ID and Worker name. No cloud resources are automatically deleted after a partial failure.

Recovery is conservative. If a database-create response is lost before its ID can be journaled or its ownership table written, an empty same-name database may be left behind; it is refused rather than adopted by guessing. Choose another name or inspect the resource in Cloudflare. Automatic database deletion and rollback are intentionally absent.

The `/api/health` endpoint checks JWT configuration and required D1 tables and reports the application version. Installation verifies that the returned version matches the target. A failed public connectivity check after an accepted Cloudflare deployment produces a distinct pending result, not a success claim. This is a readiness check; it does not prove WebSocket connectivity on every carrier or network. See `docs/UPDATE.fa.md` for the distinct server-upgrade and browser-shell update steps.

Verification covers deployment requests with a simulated Cloudflare API, multipart assets, first deployment, interrupted installation, retry after an accepted upload with a lost response, stable database/secret reuse, conflicting resources, downgrade refusal, migration replay, local-browser isolation and the packaged launcher. A persistent Miniflare upgrade test starts with the 1.0 D1/room layouts and a legacy JWT. Messenger integration tests also cover deduplication, a failed D1 indexing batch, receipts, unread counts, revoked sessions, flooding limits and oversized input. Real Chrome QA covers offline reload and delivery between two users, device revocation, finding the first unread across history pages and mobile widths. The owner reported successful Windows installation/deployment of 1.0. The 1.1 live-account upgrade and a physical Android/Termux run still need field verification; CI alone does not establish them.

API references:

- [Prefilled token templates](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/)
- [Static Assets direct uploads](https://developers.cloudflare.com/workers/static-assets/direct-upload/)
- [Worker upload metadata and strict binding inheritance](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
- [D1 database API](https://developers.cloudflare.com/api/resources/d1/subresources/database/)
- [Termux installation](https://github.com/termux/termux-app#installation)
