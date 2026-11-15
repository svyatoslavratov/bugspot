-- The screen of a thread: comments left on the map show on every page of the screen.
ALTER TABLE threads ADD COLUMN screen TEXT NOT NULL DEFAULT '';
CREATE INDEX threads_screen ON threads (project, screen, status) WHERE deleted_at IS NULL AND screen <> '';

-- The screen map: screens of the app, their states and the transitions between them.
CREATE TABLE screens (
    project       TEXT NOT NULL,
    key           TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    section       TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    title         TEXT NOT NULL DEFAULT '',
    sort_order    INTEGER NOT NULL DEFAULT 0,
    example_url   TEXT NOT NULL DEFAULT '',
    example_route TEXT NOT NULL DEFAULT '',
    -- JSON array of the roles of the people the screen was seen by.
    roles         TEXT NOT NULL DEFAULT '[]',
    hidden        INTEGER NOT NULL DEFAULT 0,
    planned       INTEGER NOT NULL DEFAULT 0,
    -- JSON {"x":…,"y":…} when moved by hand on the map.
    position      TEXT,
    first_seen    TEXT,
    last_seen     TEXT,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (project, key)
);

-- A state of a screen: '' is the page itself, 'tab:…' a selected tab, 'dialog:…' an open dialog.
-- The look is a thumbnail and a DOM snapshot (gzipped HTML; stylesheets in screen_assets).
CREATE TABLE screen_states (
    project       TEXT NOT NULL,
    screen        TEXT NOT NULL,
    key           TEXT NOT NULL,
    kind          TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    shot_type     TEXT,
    shot          BLOB,
    snapshot      BLOB,
    snapshot_css  TEXT,
    outline       TEXT,
    viewport      TEXT,
    hash          TEXT,
    captured_at   TEXT,
    last_seen     TEXT,
    PRIMARY KEY (project, screen, key)
);

CREATE TABLE screen_edges (
    project       TEXT NOT NULL,
    from_screen   TEXT NOT NULL,
    from_state    TEXT NOT NULL,
    to_screen     TEXT NOT NULL,
    to_state      TEXT NOT NULL,
    via_selector  TEXT NOT NULL,
    via_name      TEXT NOT NULL,
    via_kind      TEXT NOT NULL,
    source        TEXT NOT NULL,
    count         INTEGER NOT NULL DEFAULT 0,
    last_seen     TEXT NOT NULL,
    PRIMARY KEY (project, from_screen, from_state, to_screen, to_state, via_selector)
);
CREATE INDEX screen_edges_to ON screen_edges (project, to_screen);

-- A merged screen's key keeps pointing to the screen it was merged into.
CREATE TABLE screen_aliases (
    project TEXT NOT NULL,
    alias   TEXT NOT NULL,
    screen  TEXT NOT NULL,
    PRIMARY KEY (project, alias)
);

-- Stylesheets of snapshots, stored once under their SHA-256 (gzipped).
CREATE TABLE screen_assets (
    project      TEXT NOT NULL,
    hash         TEXT NOT NULL,
    content_type TEXT NOT NULL,
    data         BLOB NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (project, hash)
);
