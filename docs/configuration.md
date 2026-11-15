# Configuration

All settings are `PINPATH_*` environment variables. Secrets (`PINPATH_JWT_SECRET`) can also come
from a file: `PINPATH_JWT_SECRET_FILE=/run/secrets/jwt`. The service refuses to start on a wrong
value and lists every problem at once.

## Service

| Variable | Default | Meaning |
| --- | --- | --- |
| `PINPATH_ADDR` | `:8090` | listen address |
| `PINPATH_DATA_DIR` | `data` (`/data` in the image) | where `pinpath.db` (SQLite) lives |
| `PINPATH_PROJECT` | `default` | the name of this instance's threads |
| `PINPATH_ENABLED` | `true` | `false` keeps the service up but hides the widget from everyone |
| `PINPATH_ALLOWED_ORIGINS` | — | origins that may call the API from another domain, e.g. `https://app.example.com` |
| `PINPATH_TRUSTED_PROXIES` | — | addresses or CIDRs of your proxies: they may set `X-Forwarded-For`, `X-Forwarded-Proto` and, for the header provider, identity headers |
| `PINPATH_COOKIE_SECURE` | `auto` | `auto` (secure behind HTTPS), `true`, `false` |
| `PINPATH_SCREENSHOT_MAX_BYTES` | `3145728` | screenshot size limit |
| `PINPATH_RATE_READ` | `600` | reads per minute per user (or address) |
| `PINPATH_RATE_WRITE` | `60` | writes per minute per user (or address) |
| `PINPATH_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `PINPATH_BACKUP_DIR` | — | turns on snapshots of the database into this directory; keep it outside the data volume |
| `PINPATH_BACKUP_EVERY` | `24h` | how often to take a snapshot (at least `1m`); one is also taken at start |
| `PINPATH_BACKUP_KEEP_DAYS` | `14` | snapshots older than this are removed (the newest always stays); `0` keeps all |

## Access policy

| Variable | Default | Meaning |
| --- | --- | --- |
| `PINPATH_AUTH` | — | identity providers in order: `forward`, `jwt`, `header`, `key`, `anonymous` |
| `PINPATH_VIEW` | `authenticated` | who sees the widget and reads threads |
| `PINPATH_COMMENT` | `authenticated` | who writes threads and replies (needs view) |
| `PINPATH_MODERATE` | — | who changes any status and deletes any thread |
| `PINPATH_MAP` | the value of `PINPATH_MODERATE` | who opens the screen map (`/map`) and names, groups, describes and merges screens; agents need the `map` scope |
| `PINPATH_MAP_COLLECT` | the value of `PINPATH_VIEW` | whose browsing builds the map: screens, transitions, thumbnails and DOM snapshots; empty — nobody |
| `PINPATH_MAP_MASK` | `inputs` | what DOM snapshots hide: `inputs` (what people typed), `text` (all text), `none` |

Rules, comma or space separated, any match allows: `*`, `authenticated`, `anonymous`,
`role:<name>`, `user:<id>`, `provider:<name>`.

## forward

| Variable | Default | Meaning |
| --- | --- | --- |
| `PINPATH_FORWARD_URL` | — | your app's "who am I" endpoint, reachable from pinpath |
| `PINPATH_FORWARD_COOKIES` | — | cookie names to pass through (others never leave pinpath) |
| `PINPATH_FORWARD_HEADERS` | — | header names to pass through, e.g. `Authorization` |
| `PINPATH_FORWARD_MAP` | `id=id,name=name,roles=roles` | where the fields are in the JSON answer (dot paths); roles may be a string or an array |
| `PINPATH_FORWARD_CACHE` | `30s` | how long an answer is reused |
| `PINPATH_FORWARD_TIMEOUT` | `3s` | request timeout |

`2xx` with an id means signed in; `401`/`403` means not signed in; anything else is logged and the
next provider is tried.

## jwt

| Variable | Default | Meaning |
| --- | --- | --- |
| `PINPATH_JWT_SECRET` | — | HS256 secret, at least 32 bytes |
| `PINPATH_JWT_PUBLIC_KEY` | — | RS256 or ES256 public key: PEM text or a file path |
| `PINPATH_JWT_ISSUER` | — | required `iss` |
| `PINPATH_JWT_AUDIENCE` | — | required `aud` |
| `PINPATH_JWT_MAP` | `id=sub,name=name,roles=roles` | claims for the identity |

Tokens must have `exp`; 30 s of clock skew is allowed. The widget sends the token in
`X-Pinpath-Token`.

## header

| Variable | Default | Meaning |
| --- | --- | --- |
| `PINPATH_HEADER_MAP` | `id=X-Forwarded-User,name=X-Forwarded-Preferred-Username,roles=X-Forwarded-Groups` | header names |

Requires `PINPATH_TRUSTED_PROXIES`: the headers count only from those addresses.

## key

| Variable | Default | Meaning |
| --- | --- | --- |
| `PINPATH_KEY_TTL` | `720h` | how long the key cookie lives (never longer than the key) |

Keys are created with `pinpath key create --name "Customer" --roles customer --expires 336h`.

## Commands

| Command | What it does |
| --- | --- |
| `pinpath serve` | run the service (the default) |
| `pinpath healthcheck` | exit 0 when the local service is healthy (for container health checks) |
| `pinpath token create --name N [--scopes read,reply,status,map] [--expires D]` | an agent token, printed once |
| `pinpath token list` / `revoke ID` | list and revoke tokens |
| `pinpath key create --name N [--roles r1,r2] [--expires D]` | an access key for a share link, printed once |
| `pinpath key list` / `revoke ID` | list and revoke keys |
| `pinpath threads list [--status s] [--route r] [--q text] [--json]` | threads, over the API (`PINPATH_URL`, `PINPATH_TOKEN`) |
| `pinpath threads show N` | one thread with context and replies |
| `pinpath threads reply N "text"` | answer as the agent |
| `pinpath threads status N open\|in_progress\|fixed\|wontfix` | move a thread |
| `pinpath threads screenshot N --out file` | download the screenshot |
| `pinpath mcp` | an MCP server on stdio for agents (`PINPATH_URL`, `PINPATH_TOKEN`) |
| `pinpath map crawl [--buttons] [--cookie n=v] [--header 'N: v'] [--profile dir --headed] [--widget url] [--max-screens N] [--timeout D] URL` | walk the app in Chrome without a window and build the screen map (`PINPATH_TOKEN` with the read and map scopes; `PINPATH_CHROME` or `--chrome`: the browser) |
| `pinpath map export [-o file]` / `map import file` | the manifest of the screen map (`PINPATH_URL`, `PINPATH_TOKEN` with the map scope) |
| `pinpath backup [-o file]` | a consistent copy of the database, also while the service runs |

`token` and `key` work on the database directly, so run them where the service runs
(`docker compose exec pinpath pinpath token create …`).

## Backups

A snapshot is a plain SQLite file with everything in it: threads, replies, screenshots and hashed
credentials. It is written with `VACUUM INTO` to a temporary file and renamed, so it is never half
written, and it is readable by the service user only. A snapshot is taken at start, so every
upgrade leaves a copy of the data it started from; a container that restarts in a loop skips it
while the newest snapshot is under 10 minutes old.

To restore, stop the service, put the snapshot in place of `pinpath.db` in `PINPATH_DATA_DIR`,
delete `pinpath.db-wal` and `pinpath.db-shm` there, and start the service.
