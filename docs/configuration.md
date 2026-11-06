# Configuration

All settings are `BUGSPOT_*` environment variables. Secrets (`BUGSPOT_JWT_SECRET`) can also come
from a file: `BUGSPOT_JWT_SECRET_FILE=/run/secrets/jwt`. The service refuses to start on a wrong
value and lists every problem at once.

## Service

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUGSPOT_ADDR` | `:8090` | listen address |
| `BUGSPOT_DATA_DIR` | `data` (`/data` in the image) | where `bugspot.db` (SQLite) lives |
| `BUGSPOT_PROJECT` | `default` | the name of this instance's threads |
| `BUGSPOT_ENABLED` | `true` | `false` keeps the service up but hides the widget from everyone |
| `BUGSPOT_ALLOWED_ORIGINS` | — | origins that may call the API from another domain, e.g. `https://app.example.com` |
| `BUGSPOT_TRUSTED_PROXIES` | — | addresses or CIDRs of your proxies: they may set `X-Forwarded-For`, `X-Forwarded-Proto` and, for the header provider, identity headers |
| `BUGSPOT_COOKIE_SECURE` | `auto` | `auto` (secure behind HTTPS), `true`, `false` |
| `BUGSPOT_SCREENSHOT_MAX_BYTES` | `3145728` | screenshot size limit |
| `BUGSPOT_RATE_READ` | `600` | reads per minute per user (or address) |
| `BUGSPOT_RATE_WRITE` | `60` | writes per minute per user (or address) |
| `BUGSPOT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Access policy

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUGSPOT_AUTH` | — | identity providers in order: `forward`, `jwt`, `header`, `key`, `anonymous` |
| `BUGSPOT_VIEW` | `authenticated` | who sees the widget and reads threads |
| `BUGSPOT_COMMENT` | `authenticated` | who writes threads and replies (needs view) |
| `BUGSPOT_MODERATE` | — | who changes any status and deletes any thread |

Rules, comma or space separated, any match allows: `*`, `authenticated`, `anonymous`,
`role:<name>`, `user:<id>`, `provider:<name>`.

## forward

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUGSPOT_FORWARD_URL` | — | your app's "who am I" endpoint, reachable from bugspot |
| `BUGSPOT_FORWARD_COOKIES` | — | cookie names to pass through (others never leave bugspot) |
| `BUGSPOT_FORWARD_HEADERS` | — | header names to pass through, e.g. `Authorization` |
| `BUGSPOT_FORWARD_MAP` | `id=id,name=name,roles=roles` | where the fields are in the JSON answer (dot paths); roles may be a string or an array |
| `BUGSPOT_FORWARD_CACHE` | `30s` | how long an answer is reused |
| `BUGSPOT_FORWARD_TIMEOUT` | `3s` | request timeout |

`2xx` with an id means signed in; `401`/`403` means not signed in; anything else is logged and the
next provider is tried.

## jwt

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUGSPOT_JWT_SECRET` | — | HS256 secret, at least 32 bytes |
| `BUGSPOT_JWT_PUBLIC_KEY` | — | RS256 or ES256 public key: PEM text or a file path |
| `BUGSPOT_JWT_ISSUER` | — | required `iss` |
| `BUGSPOT_JWT_AUDIENCE` | — | required `aud` |
| `BUGSPOT_JWT_MAP` | `id=sub,name=name,roles=roles` | claims for the identity |

Tokens must have `exp`; 30 s of clock skew is allowed. The widget sends the token in
`X-Bugspot-Token`.

## header

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUGSPOT_HEADER_MAP` | `id=X-Forwarded-User,name=X-Forwarded-Preferred-Username,roles=X-Forwarded-Groups` | header names |

Requires `BUGSPOT_TRUSTED_PROXIES`: the headers count only from those addresses.

## key

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUGSPOT_KEY_TTL` | `720h` | how long the key cookie lives (never longer than the key) |

Keys are created with `bugspot key create --name "Customer" --roles customer --expires 336h`.

## Commands

| Command | What it does |
| --- | --- |
| `bugspot serve` | run the service (the default) |
| `bugspot healthcheck` | exit 0 when the local service is healthy (for container health checks) |
| `bugspot token create --name N [--scopes read,reply,status] [--expires D]` | an agent token, printed once |
| `bugspot token list` / `revoke ID` | list and revoke tokens |
| `bugspot key create --name N [--roles r1,r2] [--expires D]` | an access key for a share link, printed once |
| `bugspot key list` / `revoke ID` | list and revoke keys |
| `bugspot threads list [--status s] [--route r] [--q text] [--json]` | threads, over the API (`BUGSPOT_URL`, `BUGSPOT_TOKEN`) |
| `bugspot threads show N` | one thread with context and replies |
| `bugspot threads reply N "text"` | answer as the agent |
| `bugspot threads status N open\|in_progress\|fixed\|wontfix` | move a thread |
| `bugspot threads screenshot N --out file` | download the screenshot |
| `bugspot mcp` | an MCP server on stdio for agents (`BUGSPOT_URL`, `BUGSPOT_TOKEN`) |

`token` and `key` work on the database directly, so run them where the service runs
(`docker compose exec bugspot bugspot token create …`).
