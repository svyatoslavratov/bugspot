# bugspot

[![CI](https://github.com/svyatoslavratov/bugspot/actions/workflows/ci.yml/badge.svg)](https://github.com/svyatoslavratov/bugspot/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/svyatoslavratov/bugspot?sort=semver)](https://github.com/svyatoslavratov/bugspot/releases)
[![Go Reference](https://pkg.go.dev/badge/github.com/svyatoslavratov/bugspot.svg)](https://pkg.go.dev/github.com/svyatoslavratov/bugspot)
[![Coverage Status](https://coveralls.io/repos/github/svyatoslavratov/bugspot/badge.svg?branch=main)](https://coveralls.io/github/svyatoslavratov/bugspot?branch=main)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/svyatoslavratov/bugspot/badge)](https://scorecard.dev/viewer/?uri=github.com/svyatoslavratov/bugspot)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Demo](https://img.shields.io/badge/demo-live-2d72d2)](https://svyatoslavratov.github.io/bugspot/)

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

![A person comments, the agent fixes over MCP, a person checks and resolves](docs/images/demo.gif)

## Features

- **Pins on elements.** Comments stick to the element, not to coordinates: a stable selector, its
  text and the click point find it again after re-renders; a moved element is marked "not found"
  instead of being pinned to a wrong place. An element in a modal or popup keeps its pin while the
  window is open, and the thread names the window when it is closed.
- **Context for free.** A screenshot of the visible page with the element marked (or a real tab
  capture), browser and window size, app version, the last console errors and failed requests
  (with `X-Request-ID`; query values are dropped).
- **A workflow.** Open → in progress → fixed → resolved, or declined, plus a separate *checked by a
  person* box. Replies, editing by clicking the text, search, this page / all pages, pins on and off,
  "show on the page" with a short highlight, a draggable button.
- **Quick to comment.** Right-click the bug or press Alt+C (⌥C; any shortcut you like) to pick an
  element. Shift+click picks several elements with the same problem for one comment (a pin on
  each). Write in the full form in the panel or, in *tiny* mode, in a small box right at the
  element, as in Figma (Enter sends). After sending, the next element can be picked at once; Esc
  finishes. The gear in the panel header switches the mode and the shortcut.
- **Agents are first-class.** An MCP server (`bugspot mcp`), agent tokens with scopes, a CLI and a
  plain REST API. Agents move threads to *fixed*; only people check and resolve them.
- **A map of the screens.** While people use the app, the widget maps its screens, their tabs and
  dialogs, what leads where (which button or link) and how each state really looks: a thumbnail and
  a DOM snapshot. The map page shows them by section like boards in a design tool; a snapshot is
  clickable — its buttons follow the transitions, and comments left on it pin on the real page.
  "Build the map" walks the whole app at once, from the widget or headless from the command line;
  the live app opens right on the map; a manifest keeps names and descriptions in git. An agent
  names, groups and describes the screens over MCP. No framework knowledge: URLs, the DOM and ARIA.
- **Flexible access.** Identity from your app's session (`forward`), a JWT, a trusted proxy header,
  share links with access keys, or anonymous — combined in any order, with view / comment /
  moderate rules by role or user.
- **Light.** Visitors who may not see the widget download a 2.6 KB loader and make one request.
  The service is a 12 MB static binary (15 MB distroless image), SQLite inside.
- **Backups.** With `BUGSPOT_BACKUP_DIR` the service keeps dated snapshots of its database (one at
  start, then daily, kept 14 days); `bugspot backup` takes one at any time.
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
   | `data-mode` | `full` (the form in the panel), `tiny` (a small box at the element) | `full` |
   | `data-hotkey` | the picking shortcut by key code, e.g. `Alt+KeyC`, `Ctrl+Shift+KeyK`, `F2`; `off` | `Alt+KeyC` |

   `data-mode` and `data-hotkey` are defaults: each person can change them under the gear in the panel
   (kept in their browser).

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
  image: ghcr.io/svyatoslavratov/bugspot:v0.3.2
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

## Screen map

The map builds itself: whoever `BUGSPOT_MAP_COLLECT` allows (by default everyone who sees the
widget) reports, while working in the app,

- **screens** — the route with ids folded into `{id}` (`/author/0193…` → `/author/{id}`), or the
  name the page gives itself in `data-bugspot-screen`;
- **states** — the page itself, a selected tab (`role="tab"` with `aria-selected`) or an open dialog
  (`role="dialog"`, `<dialog open>`);
- **transitions** — the element clicked before the screen or state changed (its accessible name),
  the links of the page, and `data-bugspot-to` for transitions the widget cannot see (a button that
  leads somewhere only after a save);
- **the look** of each state once the page settles: a real thumbnail and a DOM snapshot without
  scripts, taken again when the layout changes. Stylesheets are stored once; what people typed is
  masked (`BUGSPOT_MAP_MASK=inputs`), or all text is (`text`).

Whoever `BUGSPOT_MAP` allows (by default the moderators) opens `<service>/map`: screens by section,
transitions between them, a panel to name, group, describe, hide and merge screens, and the
snapshot of each state. In a snapshot the known buttons and links lead where they lead, unknown
ones can be outlined, and *Comment* pins a thread on any element — the same thread shows on every
real page of that screen.

The widget's panel has a map button: it opens the map at the screen you are on.

**Build it at once.** *Screen map → Build the map…* in the widget (for those who may open the map
and build it) walks the app by itself: it opens the app in a frame of the same origin, loads every
screen a link leads to, selects the tabs, opens the windows buttons promise, and records each
state with its look and the transitions. It changes no data: only reads leave the walked app —
any other request fails as a network error would (from the command line the browser stops them
too) — forms do not submit, `confirm()` answers no, and buttons named like deleting, sending,
saving, paying or signing out are never pressed; other buttons are pressed only when you tick it,
or when the app marks them (`aria-haspopup="dialog"`, `data-bugspot-crawl`). The same crawl runs
headless in Chrome:

```sh
bugspot token create --name crawler --scopes read,map         # next to the service
BUGSPOT_TOKEN=bsp_… bugspot map crawl https://app.example.com/ \
  --cookie session=…            # or sign in once: --headed --profile ~/.bugspot-chrome
```

`--buttons` presses more buttons, `--max-screens` and `--timeout` bound the walk, `--widget
https://app.example.com/bugspot` adds the widget to pages that do not load it, and a stand behind
Basic Auth takes the credentials in the address. It needs Chrome or Chromium (`--chrome`, or
`BUGSPOT_CHROME`) on macOS or Linux.

**The live app.** A screen opens as its snapshot or, with *Live app*, as the real app in a frame:
work in it, comment with its widget, and the map follows the screen it is on. The app has to allow
the bugspot origin to frame it (`frame-ancestors`), see [integration](docs/integration.md#the-screen-map).

**A manifest.** What people and agents wrote about the screens — names, sections, descriptions,
described states, declared transitions — goes to a JSON file and back: *⋯ → Download / Upload the
manifest* on the map, or `bugspot map export -o map.json` and `bugspot map import map.json`. Keys may
be route patterns of your router (`/authors/:id`, `/authors/[id]`); screens the map has not seen
become planned ones. A script that reads your router can write it, and git keeps it.

```json
{"version": 1, "screens": [
  {"key": "/authors/:id", "name": "Author card", "section": "Authors", "description": "…",
   "states": [{"key": "tab:Responses", "description": "…"}],
   "to": ["/authors", {"screen": "/reports", "via": "Report", "kind": "link"}]}
]}
```

Hints, all optional:

| Attribute | Where | What it does |
| --- | --- | --- |
| `data-bugspot-screen="author-card"` | any element of a page | names the screen when the URL does not tell screens apart |
| `data-route-params="tab,view"` | the `<script>` tag | query parameters that make different screens (otherwise tabs in the query are states of one screen) |
| `data-bugspot-to="/reports"` | a button or link | declares where it leads |
| `data-bugspot-nav` | a container | marks the app's own menu (`nav`, `aside`, `header` are recognized anyway) |
| `data-bugspot-mask` | any element | masks its text and values in snapshots |
| `data-bugspot-ignore` | any element | leaves it out of snapshots and of the map |
| `data-bugspot-crawl` | a button | the crawl may press it (`="skip"`: never) |

## Agents

### MCP

`bugspot mcp` is an MCP server on stdio with the tools `list_threads`, `get_thread`,
`get_screenshot` (the image itself), `reply`, `set_status` and `summary`. It works through the API
with an agent token, so the agent has exactly the token's rights.

With the `map` scope the agent also reads and edits the screen map: `get_map` (screens by section
with their states and transitions), `get_screen` (the outline of each state: headings, actions,
fields, tables), `get_screen_image` (a real thumbnail), `update_screens` (name, section,
description, order, hide, merge duplicates), `update_states`, `add_screen` (a planned screen) and
`add_edge` (a transition the widget cannot see). Ask it *"Group the screens of the bugspot map and
describe what each is for"*.

```sh
# Claude Code
claude mcp add bugspot --env BUGSPOT_URL=https://app.example.com/bugspot --env BUGSPOT_TOKEN=bsp_… -- bugspot mcp
# without a local binary
claude mcp add bugspot -- docker run -i --rm -e BUGSPOT_URL=… -e BUGSPOT_TOKEN=… ghcr.io/svyatoslavratov/bugspot mcp
```

Then: *"Fix the open bugspot comments"* — the agent lists them, looks at the screenshots, takes one
into work, fixes the code, replies and sets *fixed*. A person checks the result, ticks *checked*
and resolves.

### CLI

```sh
# next to the service: create a token (shown once; only its hash is stored)
docker compose exec bugspot bugspot token create --name claude --scopes read,reply,status,map

# anywhere: read and answer
export BUGSPOT_URL=https://app.example.com/bugspot BUGSPOT_TOKEN=bsp_…
bugspot threads list                     # open and in progress
bugspot threads show 12                  # text, element, context, replies
bugspot threads screenshot 12 --out 12.webp
bugspot threads status 12 in_progress
bugspot threads reply 12 "Fixed in 1.4.3: the column wraps now."
bugspot threads status 12 fixed
bugspot map export -o map.json           # the manifest of the screen map; map import applies one
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
