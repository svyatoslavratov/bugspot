# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com), and the project uses
[semantic versioning](https://semver.org).

## [Unreleased]

## [0.6.0] - 2026-11-15

### Added

- The screen map works like a design tool: screens at their real size, and their names, the frame
  titles, the arrows, their names and the pins the same size on screen at any zoom. Far out a
  screen shows no name, only a dot when it has open threads; the names of arrows show from a
  quarter of the real size.
- Moving around: dragging the canvas or a screen, the wheel or two fingers, the arrows or WASD;
  zoom with Ctrl/⌘ and the wheel, a pinch, `+` and `−`; Shift+1 for the whole map, Shift+2 for the
  selected screen. A screen moves when its name is dragged. `C` (or the widget's shortcut) turns on
  comments on the canvas; the keys are listed under `?`.
- Tabs of one page that have addresses of their own stand side by side in a box named by the
  page, each named by its tab, with no arrows between them.
- The map's toolbar shows its actions instead of a menu: *Show* (links, the menu, hidden screens,
  each explained, and what the arrows mean), *Comment*, *Build the map*, *Reset the layout*,
  *Manifest* — a dialog that says what the manifest is for and how to use it, with an example,
  download and upload.
- A language setting in the widget and on the map: the browser's by default, or Russian or
  English; the choice is kept in the browser.
- The panel of a screen: a description field that grows as you type, transitions as rows with the
  screen's picture and the elements they go through, and *This is a duplicate…* explains merging.
- The crawl dialog says whose role a crawl collects.

### Changed

- The map is laid out in a worker, and the screen in focus stands out without redrawing the
  arrows: hovering and toggles do not freeze a large map, and a layout shows a spinner.
- Thumbnails are 800 pixels wide: up close a screen is its live snapshot anyway.
- Positions of screens moved by hand are reset once: the map's scale has changed.
- `data-lang` is the language for browsers in neither Russian nor English; people choose theirs in
  the settings.
- Ctrl/⌘ with a mouse wheel zooms by about a quarter a notch instead of fourfold.

### Fixed

- The progress of a crawl did not move while it worked: it animates off the main thread, and the
  crawl takes the snapshot and the thumbnail one after another with a pause between.
- Dragging over a screen moved it instead of the canvas.

## [0.5.0] - 2026-11-15

### Added

- The screen map is laid out by ELK: screens of a frame in layers along their transitions with
  few crossings and arrows routed around them; a screen that leads to many dead ends gets them as
  a grid block with arrows along the gaps between rows. Arrows of the screen in focus (under the
  pointer or selected) stand out with their names; arrows between frames show only for it.
- Screens up close are their live DOM snapshots on the canvas, sharp at any zoom and with the pins
  of their threads, and *Comment* on the toolbar picks an element right there; a far screen
  clicked in the comment mode comes close.
- *Reset the layout* in the map's menu, and `resetPosition` in `PATCH /api/v1/map/screens`.
- The demo has the screen map: the app builds it while you click around, `map.html` shows it with
  the same API in WebAssembly, and its state (with the looks) is kept in IndexedDB. The demo shows
  the commit it was built from.

### Fixed

- A screen moved by hand stretched its frame over the others; now it floats and the frame keeps
  the size of its layout.
- Thumbnails were blurry up close: they are taken twice as large.
- A screen whose page has tabs was shown by its window rather than by a tab.


### Changed

- bugspot is now **pinpath**: it does more than pin comments since the screen map came. The
  repository is github.com/svyatoslavratov/pinpath (old links redirect), the Go module, the binary
  and the image are `pinpath` (`ghcr.io/svyatoslavratov/pinpath`), and the names inside follow:
  `PINPATH_*` variables, `data-pinpath-*` attributes, `X-Pinpath-Token` and `X-Pinpath-Request`
  headers, `ppt_` agent tokens and `ppk_` access keys, `?pinpath_key=` links, `window.pinpath` and
  `window.pinpathConfig`, `<pinpath-widget>`, the `pinpath.db` file and `pinpath-*.db` snapshots.
- What was set up under the old names keeps working: `BUGSPOT_*` variables (listed in a warning at
  start), `data-bugspot-*` attributes on pages, `X-Bugspot-*` headers, `bsp_`/`bsk_` credentials, the
  `bugspot_anon` and `bugspot_key` cookies, `?bugspot_key=` links, `window.bugspotConfig`, settings
  saved in browsers, snapshots of the map taken before, the `bugspot.db` file (used while there is
  no `pinpath.db`) and `bugspot-*.db` snapshots (pruned as before).
- Scripts that run the binary by name need `pinpath` instead of `bugspot`, e.g.
  `docker compose exec pinpath pinpath token create`.
- The Docker Compose example names its volume `pinpath-data`. A setup copied from the example
  before keeps its data only under the old name: keep `bugspot-data` in your compose file (or copy
  the volume) when you switch the image.

## [0.4.0] - 2026-11-15

### Added

- A map of the screens at `/map`. While people use the app, the widget records its screens (routes
  with ids folded to `{id}`), their tabs and windows, which button or link leads where, and how each
  state really looks: a thumbnail and a DOM snapshot without scripts, taken again when the layout
  changes. The map lays screens out in sections along their transitions; a snapshot opens as a
  clickable page whose known controls follow the transitions, and a comment on it pins to the real
  page too. Screens are named, grouped, described, hidden and merged on the map or by an agent.
  `BUGSPOT_MAP` (default: who moderates) opens it, `BUGSPOT_MAP_COLLECT` (default: who sees the
  widget) builds it, `BUGSPOT_MAP_MASK` sets what snapshots hide. Optional hints:
  `data-bugspot-screen`, `data-route-params`, `data-bugspot-to`, `data-bugspot-nav`,
  `data-bugspot-mask`, `data-bugspot-ignore`.
- MCP tools for the map, behind the new `map` token scope: `get_map`, `get_screen`,
  `get_screen_image`, `update_screens`, `update_states`, `add_screen`, `add_edge`.
- Threads remember their screen (`screen`), and lists and summaries filter by it, so a comment left
  on `/author/1` shows on `/author/2` when it is about the screen.
- Building the map at once: *Screen map → Build the map…* in the widget walks the app in a frame of
  its origin (or a window when frames are refused) — links, tabs, windows that buttons promise, the
  first clickable row of each table — and records every state with its look. Only reads leave the
  walked app (other requests fail; the headless crawl stops them in the browser too), it never
  presses buttons named like deleting, sending, saving, paying or signing out, forms do not submit,
  and `confirm()` answers no; more buttons only when asked or marked with `data-bugspot-crawl`.
  `bugspot map crawl <url>` runs the same crawl in headless Chrome with an agent token (read and
  map scopes), with `--cookie`, `--header`, `--profile`, `--buttons` and `--widget`; agents with the
  map scope may now report to the map.
- The live app on the map: a screen opens as its snapshot or as the real app in a frame, and the
  map follows the screen the app's widget reports. The map page lets the allowed origins into its
  frames.
- A manifest of the map (`GET`/`POST /api/v1/map/manifest`, `bugspot map export|import`, and the map's
  menu): names, sections, descriptions, state descriptions and declared transitions as a JSON file;
  route patterns (`/authors/:id`) fold into screen keys, unknown screens become planned.
- The widget's panel opens the map at the current screen.

### Fixed

- Widget chunks served to an app on another origin failed to load as modules: `/assets/` now sends
  `Access-Control-Allow-Origin: *`.

## [0.3.2] - 2026-11-07

### Fixed

- A comment on an element of a modal kept its pin at the old click point after the modal closed,
  over unrelated content. Pins now go on found elements only; the anchor remembers the modal or
  popup (`anchor.layer`: kind and title), the thread says "the element is in the window «…» — open
  it to see the pin", and "show on the page" does not flash a stray ring. When the window opens
  again, the pin is back on its element.

## [0.3.1] - 2026-11-07

### Fixed

- Closing the panel with an unsent comment form (picked in the full form, or a tiny box expanded to
  it) left the form behind: the picking shortcut stayed silent and the form came back on the next
  open. Closing the panel now cancels the form, as "Cancel" does.

## [0.3.0] - 2026-11-06

### Added

- Settings under a gear in the panel header: the comment form and the picking shortcut.
- Tiny mode: a small box right at the picked element, as in Figma — Enter sends, Shift+Enter starts
  a new line, Esc cancels, the screenshot is attached on its own, "expand" moves the text to the
  full form. With several elements their numbered frames stay and the box sits at the last one.
  `data-mode` sets the default; each person switches it under the gear.
- A picking shortcut, Alt+C (⌥C) by default: by the physical key, so any keyboard layout works; a
  second press cancels. Each person records their own or turns it off under the gear; `data-hotkey`
  sets the default. The right click on the bug still picks at once.
- A quiet link to the project under the panel.

### Changed

- "Show on the page" and "Open the page" are icons with tooltips: the thread header fits one line.
- The status filter of the list is a tag with a menu, like the thread's status.

### Fixed

- A clicked tab, menu item or button kept its focus ring until the next click elsewhere: the ring
  now shows for keyboard focus only (Blueprint's focus manager marks the page, which the shadow root
  does not see).

## [0.2.0] - 2026-11-06

### Added

- Several elements in one comment: Shift+click picks them (Shift+click again drops one), a plain
  click on the last one or Enter finishes. A pin with the same number goes on each element; "show
  on the page" and the screenshot mark them all. They are stored in `anchor.more`.
- After sending a comment, picking goes on at once with a note about the sent one; Esc finishes and
  brings the panel back as it was.
- Backups: `BUGSPOT_BACKUP_DIR`, `BUGSPOT_BACKUP_EVERY`, `BUGSPOT_BACKUP_KEEP_DAYS` keep dated
  snapshots of the database; `bugspot backup` takes one at any time.

## [0.1.1] - 2026-11-06

### Fixed

- The tooltip of a pin opened in the top left corner of the page instead of at the pin.

## [0.1.0] - 2026-11-06

The first release.

- Go service: SQLite storage, the widget embedded in the binary, REST API (`api/openapi.yaml`),
  CLI for agent tokens, access keys and threads.
- Identity providers `forward`, `jwt`, `header`, `key`, `anonymous` and a view / comment / moderate
  policy by role, user or provider.
- Widget: a draggable bug (right-click or Alt+click comments on an element at once), the panel
  (this page / all, statuses, search, pins on and off), pins on elements, element picking,
  screenshots with the element marked, page context, replies, statuses from the status tag, editing
  by clicking the text, "show on the page" with a highlight, English and Russian.
- "Checked by a person": a separate mark only people set; reopening clears it.
- `bugspot mcp`: an MCP server for agents (list, read, screenshot, reply, move threads).
- The GitHub Pages demo with the API compiled to WebAssembly.
- Releases: binaries for Linux and macOS and a multi-arch image, signed keylessly with Sigstore,
  with SLSA provenance and an SBOM.
