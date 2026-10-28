# WIHM Installer

A Persian local-browser installer. Runtime dependency: Node.js 22+. No npm install, Wrangler, workerd, native extensions or Git on the end user's device. `install.ps1` and `install.sh` prepare Node if needed; Termux uses its own `nodejs-lts` package instead of a desktop Linux binary.

Build from the repository root:

```sh
npm ci
npm run installer:build
node scripts/check-installer.mjs
npm run installer:start
```

The distributable is `dist/WIHM-Installer`. CI builds ZIP and tar.gz archives and SHA-256 checksums. A tag named `installer-v*` publishes them after Windows, macOS and Linux checks pass. When preparing a new installer version, update the version and pinned download tag in launchers, the UI, build metadata, documentation and workflow release title together.

`cloudflare.mjs` uses the fixed official API origin and never displays raw provider error text. `deploy.mjs` checks ownership, prepares a workers.dev address, creates or reuses D1, initializes the additive schema, uploads Static Assets, uploads the precompiled Worker with its SQLite Durable Object migration, and enables the public address. Updating an installer-managed Worker inherits `JWT_SECRET` using strict binding inheritance; it does not regenerate the secret or replay the initial migration. Unrecognized Workers or databases are refused. Manually installed instances need a future explicit migration path.

`server.mjs` binds only to `127.0.0.1` on a random port. A random session key in the initial URL fragment authorizes API requests; it is removed from the visible URL and retained in tab session storage. Host, Origin and fetch-site checks restrict browser access. API credentials stay in the server process's memory. Stopping the installer drops credentials. The on-disk recovery journal contains only database identifiers, scoped by account ID and Worker name. No cloud resources are automatically deleted after a partial failure.

Recovery is conservative. If a database-create response is lost before its ID can be journaled or its ownership table written, an empty same-name database may be left behind; it is refused rather than adopted by guessing. Choose another name or inspect the resource in Cloudflare. Automatic database deletion and rollback are intentionally absent.

The `/api/health` endpoint checks the JWT configuration and presence of the four D1 tables. A failed public connectivity check after an accepted Cloudflare deployment produces a distinct pending result, not a success claim. This is a readiness check; it does not prove WebSocket connectivity on every carrier or network.

Verification covers deployment requests with a simulated Cloudflare API, multipart asset content, first deployment, interrupted installation, retry after an accepted upload with a lost response, stable database/secret reuse, conflicting resource refusal, local-browser isolation, and the actual packaged launcher. Messenger integration tests exercise authentication, D1, Durable Objects and WebSockets in Miniflare. Browser QA also covers mobile widths, reload during installation, error/retry and completion. A live account deployment and a physical Android/Termux run still require field verification; CI alone does not establish them.

API references:

- [Prefilled token templates](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/)
- [Static Assets direct uploads](https://developers.cloudflare.com/workers/static-assets/direct-upload/)
- [Worker upload metadata and strict binding inheritance](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
- [D1 database API](https://developers.cloudflare.com/api/resources/d1/subresources/database/)
- [Termux installation](https://github.com/termux/termux-app#installation)
