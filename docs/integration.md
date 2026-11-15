# Integration recipes

The service needs three things from you: to run, to be reachable from the browser, and a
`<script>` tag on the pages. Everything else is configuration.

## Same domain behind nginx (recommended)

```nginx
location /pinpath/ {
    proxy_pass http://pinpath:8090/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 4m;   # screenshots
}
```

Set `PINPATH_TRUSTED_PROXIES` to the proxy's address (or the Docker network, e.g. `172.16.0.0/12`)
so rate limits see real client addresses and cookies get `Secure` behind HTTPS.

```html
<script defer src="/pinpath/widget.js" data-version="1.4.2"></script>
```

With a strict Content-Security-Policy, nothing extra is needed: the scripts come from your own
origin, and the widget's styles are constructed stylesheets inside a Shadow DOM.

## Traefik

```yaml
labels:
  - traefik.http.routers.pinpath.rule=Host(`app.example.com`) && PathPrefix(`/pinpath`)
  - traefik.http.middlewares.pinpath-strip.stripprefix.prefixes=/pinpath
  - traefik.http.routers.pinpath.middlewares=pinpath-strip
  - traefik.http.services.pinpath.loadbalancer.server.port=8090
```

## Single-page apps and dev servers

- Hash routers (`#/campaigns`) are detected; force with `data-route="hash"`. Pins match the route
  without the query, so filters do not split a page's comments.
- Vite dev server: proxy the service and the widget appears in local development too.

  ```ts
  // vite.config.ts
  server: { proxy: { '/pinpath': { target: 'http://localhost:8090', rewrite: (p) => p.replace(/^\/pinpath/, '') } } }
  ```

- Load the script only where you want it, e.g. from a runtime flag:

  ```ts
  if (config.pinpathUrl) {
    const s = document.createElement('script');
    s.defer = true;
    s.src = `${config.pinpathUrl}/widget.js`;
    s.dataset.version = BUILD_VERSION;
    document.head.append(s);
  }
  ```

- Stable pins: give important elements `data-pinpath="name"`. Without it the widget uses ids,
  `data-testid`, `aria-label`, `name`, `title`, `placeholder`, then a short path, and falls back to
  the element's text.
- Source locations: if your dev build adds `data-pinpath-src="src/pages/Campaigns.tsx:42"` to
  elements, threads keep it, so an agent opens the right file at once.

## The screen map

Nothing to set up: once someone allowed by `PINPATH_MAP_COLLECT` uses the app, the map at
`<pinpath>/map` fills with its screens, tabs and windows, the transitions between them and their
real looks. It only reads addresses, the DOM and ARIA, so it does not care about the framework.
Hints for what it cannot see, all optional:

- `data-pinpath-screen="author-card"` on any element names the screen when the address does not
  tell screens apart (one route for several pages, a wizard on one address).
- `data-route-params="tab,view"` on the script tag lists the query parameters that make different
  screens. Others are dropped from the key, so `?tab=` stays a state of one screen.
- `data-pinpath-to="/reports"` on a button or link declares where it leads, for transitions that
  happen only after a save or a confirmation.
- `data-pinpath-nav` marks the app's own menu, so its links do not tie every screen to every other
  one (`nav`, `aside` and `header` count already).
- `data-pinpath-mask` hides an element's text and values in DOM snapshots; `PINPATH_MAP_MASK`
  sets what is hidden everywhere (`inputs` by default).
- `data-pinpath-ignore` keeps an element out of snapshots and out of the map.

Real tabs (`role="tab"` with `aria-selected`) and windows (`role="dialog"` with a title or
`aria-modal`, `<dialog open>`) become states of the screen by themselves; popups that call
themselves dialogs without either (date pickers, sort menus) do not.

**Building the map at once.** The crawl (*Build the map* in the widget, or `pinpath map crawl`)
lets only reads out of the app it walks: `fetch`, `XMLHttpRequest` and `sendBeacon` refuse anything
else, and the headless crawl fails such requests in the browser as well, so pressing a button that
saves at once (a rating, a toggle) changes nothing. It opens the app in a frame of its own origin, so `X-Frame-Options: SAMEORIGIN` is fine; with `DENY`
or `frame-ancestors 'none'` the widget offers a separate window instead. The widget does not start
inside the crawler's frame (its name begins with `pinpath-crawl`). Mark buttons that open windows
with `aria-haspopup="dialog"` or `data-pinpath-crawl` so the crawl presses them by default, and
`data-pinpath-crawl="skip"` on any it must leave alone.

**The live app on the map** is the app in a frame of the map page: allow the pinpath origin in your
app's `frame-ancestors` (nothing to do when pinpath is under the app's domain, `/pinpath/`), and keep
the app in `PINPATH_ALLOWED_ORIGINS` — the map lets those origins into its frames. Cookies of the
app reach the frame when the map is on the same site (same registrable domain); the widget inside
tells the map which screen it is on. Snapshots keep the page's styles, so stylesheets on another
origin need CORS to be read; without it the snapshot falls back to the stylesheet's address.

## forward: your app's session

Your app needs an endpoint that answers who the current user is, by the session cookie:

```http
GET /api/me
Cookie: session=…

200 {"user": {"id": 7, "name": "Anna", "role": "admin"}}
401 when not signed in
```

```env
PINPATH_AUTH=forward
PINPATH_FORWARD_URL=http://app:8080/api/me
PINPATH_FORWARD_COOKIES=session
PINPATH_FORWARD_MAP=id=user.id,name=user.name,roles=user.role
```

Roles may be one string (`"admin"`), a comma-separated string or an array.

## jwt: tokens from your backend

Your backend signs a short-lived token for the signed-in user; the page gives it to the widget.

```go
// Go, github.com/golang-jwt/jwt/v5
claims := jwt.MapClaims{
    "sub": user.ID, "name": user.Name, "roles": user.Roles,
    "iss": "my-app", "exp": time.Now().Add(10 * time.Minute).Unix(),
}
token, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret)
```

```js
// Node, jsonwebtoken
const token = jwt.sign({ sub: user.id, name: user.name, roles: user.roles }, secret, {
  issuer: 'my-app', expiresIn: '10m',
});
```

```html
<script>
  window.pinpathConfig = { token: () => fetch('/api/pinpath-token').then((r) => r.text()) };
</script>
<script defer src="https://feedback.example.com/widget.js"></script>
```

```env
PINPATH_AUTH=jwt
PINPATH_JWT_SECRET_FILE=/run/secrets/pinpath_jwt   # or PINPATH_JWT_PUBLIC_KEY for RS256/ES256
PINPATH_JWT_ISSUER=my-app
PINPATH_ALLOWED_ORIGINS=https://app.example.com    # when the service is on another domain
```

## header: behind an auth proxy

oauth2-proxy, Authelia and Traefik forward auth already know the user and pass headers:

```env
PINPATH_AUTH=header
PINPATH_HEADER_MAP=id=X-Forwarded-Email,name=X-Forwarded-Preferred-Username,roles=X-Forwarded-Groups
PINPATH_TRUSTED_PROXIES=10.0.0.5
```

Headers from any other address are ignored, so a client cannot forge them.

## key: a link for someone without an account

```sh
pinpath key create --name "Customer: Acme" --roles customer --expires 336h
# → ppk_…   share https://stage.example.com/?pinpath_key=ppk_…
```

The loader exchanges the key for an httpOnly cookie and removes it from the address bar.
Combine with your own users: `PINPATH_AUTH=forward,key` and add `provider:key` to the rules.
Revoke with `pinpath key revoke ID`.

## Another domain

When the service is not under your app's domain, the browser will not send your app's cookies to
it. Use `jwt` (or `key`), and list your app's origin:

```env
PINPATH_ALLOWED_ORIGINS=https://app.example.com,https://stage.example.com
```

```html
<script defer src="https://feedback.example.com/widget.js"></script>
```

## Backups

Everything is in `pinpath.db` in `PINPATH_DATA_DIR`. Back it up while running with
`sqlite3 pinpath.db ".backup backup.db"`, or stop the service and copy the file.
