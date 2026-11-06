# bugspot

[![CI](https://github.com/svyatoslavratov/bugspot/actions/workflows/ci.yml/badge.svg)](https://github.com/svyatoslavratov/bugspot/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

**Pinned page comments for your team and your agents.** A floating bug on any web app: click it, pick
an element, write what is wrong. The comment is pinned to that element with a screenshot, the
browser, the app version, recent console errors and failed requests. Developers — or an AI agent
with an API token — answer in the thread, move it to *in progress* and *fixed*; the author checks
and resolves it.

One small Go service stores everything (SQLite, one file) and serves the widget itself. You add
one `<script>` tag. Who sees the widget is up to you: from everyone to nobody but admins, using
your app's own login.

**[Try the demo →](https://svyatoslavratov.github.io/bugspot/)** (the API runs in your browser as WebAssembly)

[Русская версия](README.ru.md)

![The panel with threads and pins on the page](docs/images/panel.png)

## Features

- **Pins on elements.** Comments stick to the element, not to coordinates: a stable selector, its
  text and the click point find it again after re-renders; a moved element is marked "not found"
  instead of being pinned to a wrong place.
- **Context for free.** A screenshot of the visible page with the element marked (or a real tab
  capture), browser and window size, app version, the last console errors and failed requests
  (with `X-Request-ID`; query values are dropped).
- **A workflow.** Open → in progress → fixed → resolved, or declined. Replies, edit, delete, search,
  this page / all pages, pins on and off, a draggable button.
- **Agents are first-class.** Agent tokens with scopes, a CLI (`bugspot threads list/show/reply/status/screenshot`)
  and a plain REST API. Agents move threads to *fixed*; only people resolve them.
- **Flexible access.** Identity from your app's session (`forward`), a JWT, a trusted proxy header,
  share links with access keys, or anonymous — combined in any order, with view / comment /
  moderate rules by role or user.
- **Light.** Visitors who may not see the widget download a 2.6 KB loader and make one request.
  The service is a 12 MB static binary (15 MB distroless image), SQLite inside.
- **Safe by default.** CSRF protection, CORS allowlist, rate limits, size limits, sniffed images
  only, hashed credentials, non-root read-only container. See [SECURITY.md](SECURITY.md).

The widget is React + [Blueprint](https://blueprintjs.com) inside a Shadow DOM, so it neither
breaks nor inherits your styles.

## Quick start

```sh
docker run -d --name bugspot -p 8090:8090 -v bugspot-data:/data \
  -e BUGSPOT_AUTH=anonymous -e 'BUGSPOT_VIEW=*' -e 'BUGSPOT_COMMENT=*' \
  -e BUGSPOT_ALLOWED_ORIGINS=http://localhost:3000 \
  ghcr.io/svyatoslavratov/bugspot:latest
```

and on a page of your app at `http://localhost:3000`:

```html
<script defer src="http://localhost:8090/widget.js"></script>
```

That is a public setup to try it out; read on for real access control. A complete example with
nginx is in [examples/docker-compose](examples/docker-compose).

## Connect it to your app

1. **Run the service** next to your app (Docker image, or a binary from the
   [releases](https://github.com/svyatoslavratov/bugspot/releases)). Keep `/data` on a volume.
2. **Serve it under your app's domain**, so cookies and CSP just work:

   ```nginx
   location /bugspot/ {
       proxy_pass http://bugspot:8090/;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

   A different domain also works: list your app in `BUGSPOT_ALLOWED_ORIGINS` and use the `jwt`
   or `key` provider (a cookie of your app does not travel to another site).
3. **Add the script** to your pages — only in the environments where you want it:

   ```html
   <script defer src="/bugspot/widget.js" data-version="1.4.2"></script>
   ```

   | Attribute | Values | Default |
   | --- | --- | --- |
   | `data-api` | service root | the directory of `widget.js` |
   | `data-route` | `auto`, `path`, `hash` (hash routers: `#/page`) | `auto` |
   | `data-version` | your app version, saved with each thread | — |
   | `data-lang` | `en`, `ru` | browser language |
   | `data-theme` | `light`, `dark`, `auto` | `light` |
   | `data-position` | `bottom-right`, `bottom-left`, `top-right`, `top-left` | `bottom-right` |

   `window.bugspotConfig = { token, appVersion, fetch }` set before the script overrides these
   from code (`token` returns a JWT for the `jwt` provider).

The widget never decides access by itself: the loader asks `GET /api/v1/session`, and only when the
service answers `visible: true` does it download the app.

### Who sees the widget

Two layers: **identity providers** say who the user is, the **policy** says what they may do.

`BUGSPOT_AUTH` lists providers in order; the first that recognizes the request wins.

| Provider | Use it when | What your app does |
| --- | --- | --- |
| `forward` | your app has a cookie session on the same domain | nothing: bugspot calls your "who am I" endpoint with the user's cookie and maps the JSON |
| `jwt` | another domain, or you want to pass exact roles | your backend signs a short JWT (HS256, RS256 or ES256); the page returns it from `bugspotConfig.token` |
| `header` | an auth proxy (oauth2-proxy, Authelia, Traefik) is in front | nothing: headers are trusted from `BUGSPOT_TRUSTED_PROXIES` only |
| `key` | someone without an account (a customer) should comment | send a link `?bugspot_key=bsk_…`; the key becomes an httpOnly cookie |
| `anonymous` | public feedback | nothing; guests type their name |

The policy has three permissions, each a list of rules (any match allows):

- `BUGSPOT_VIEW` — see the widget and read threads;
- `BUGSPOT_COMMENT` — write threads and replies, edit and resolve one's own;
- `BUGSPOT_MODERATE` — change any status, delete any thread.

Rules: `*` (everyone), `authenticated` (anyone but anonymous), `anonymous`, `role:<name>`,
`user:<id>`, `provider:<name>`.

| You want | Settings |
| --- | --- |
| Only admins | `BUGSPOT_VIEW=role:admin` `BUGSPOT_COMMENT=role:admin` |
| The whole team writes, leads close | `BUGSPOT_VIEW=authenticated` `BUGSPOT_COMMENT=authenticated` `BUGSPOT_MODERATE=role:lead` |
| Plus a customer by link | add `BUGSPOT_AUTH=…,key` and `provider:key` to `BUGSPOT_VIEW` and `BUGSPOT_COMMENT` |
| Public | `BUGSPOT_AUTH=anonymous` `BUGSPOT_VIEW=*` `BUGSPOT_COMMENT=*` |
| Off | `BUGSPOT_ENABLED=false`, or do not add the script |

### Example: an app with a cookie session

The app answers `GET /api/me` with `{"user": {"id": 7, "name": "Anna", "role": "admin"}}` for a
signed-in user and `401` otherwise:

```yaml
bugspot:
  image: ghcr.io/svyatoslavratov/bugspot:v0.1.0
  read_only: true
  volumes: [bugspot-data:/data]
  environment:
    BUGSPOT_PROJECT: crm
    BUGSPOT_AUTH: forward
    BUGSPOT_FORWARD_URL: http://app:8080/api/me
    BUGSPOT_FORWARD_COOKIES: session
    BUGSPOT_FORWARD_MAP: id=user.id,name=user.name,roles=user.role
    BUGSPOT_VIEW: authenticated
    BUGSPOT_COMMENT: authenticated
    BUGSPOT_MODERATE: role:admin
    BUGSPOT_TRUSTED_PROXIES: 172.16.0.0/12
```

Only the listed cookies are forwarded, only to that URL; answers are cached for 30 s.
More recipes (JWT in Go and Node, oauth2-proxy, another domain): [docs/integration.md](docs/integration.md).

## Agents

```sh
# next to the service: create a token (shown once; only its hash is stored)
docker compose exec bugspot bugspot token create --name claude --scopes read,reply,status

# anywhere: read and answer
export BUGSPOT_URL=https://app.example.com/bugspot BUGSPOT_TOKEN=bsp_…
bugspot threads list                     # open and in progress
bugspot threads show 12                  # text, element, context, replies
bugspot threads screenshot 12 --out 12.webp
bugspot threads status 12 in_progress
bugspot threads reply 12 "Fixed in 1.4.3: the column wraps now."
bugspot threads status 12 fixed
```

A stand behind HTTP Basic Auth: put the credentials into the URL
(`https://user:pass@dev.example.com/bugspot`); the token travels in `X-Bugspot-Token`, so the two do
not collide. The API is described in [api/openapi.yaml](api/openapi.yaml).

## Configuration

Everything is set with `BUGSPOT_*` environment variables; secrets also accept `*_FILE`. The full
list with defaults: [docs/configuration.md](docs/configuration.md).

## Development

```sh
make widget      # build the widget (Node 22) into internal/widgetfs/dist
make build       # bin/bugspot with the widget inside
make test        # Go tests (race) and widget tests
make demo        # the GitHub Pages demo in _site/
make run         # a public local instance on :8090
```

The repository: `cmd/bugspot` (service and CLI), `cmd/bugspot-wasm` (the demo backend),
`internal/` (auth, store, HTTP API), `widget/` (loader and app), `api/openapi.yaml`, `demo/`,
`examples/`.

## License

[AGPL-3.0](LICENSE). Running bugspot and adding its script to your app does not make your app
AGPL: it talks to bugspot over HTTP. If you change bugspot itself and let people use it over a
network, publish your changes. For other terms, open an issue.
