# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com), and the project uses
[semantic versioning](https://semver.org).

## [Unreleased]

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
