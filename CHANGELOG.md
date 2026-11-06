# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com), and the project uses
[semantic versioning](https://semver.org).

## [Unreleased]

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
