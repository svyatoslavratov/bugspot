CREATE TABLE threads (
    id             TEXT PRIMARY KEY,
    number         INTEGER NOT NULL,
    project        TEXT NOT NULL,
    route          TEXT NOT NULL,
    url            TEXT NOT NULL,
    title          TEXT NOT NULL,
    kind           TEXT NOT NULL,
    status         TEXT NOT NULL,
    status_by      TEXT,
    status_at      TEXT,
    -- A person confirmed the result: who and when; empty while not checked.
    verified_by    TEXT,
    verified_at    TEXT,
    body           TEXT NOT NULL,
    anchor         TEXT NOT NULL,
    context        TEXT NOT NULL,
    author_id      TEXT NOT NULL,
    author_name    TEXT NOT NULL,
    author_kind    TEXT NOT NULL,
    has_screenshot INTEGER NOT NULL DEFAULT 0,
    reply_count    INTEGER NOT NULL DEFAULT 0,
    -- Lowercased body, author and route: SQLite lower() and LIKE fold only ASCII.
    search         TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    deleted_at     TEXT
);
CREATE UNIQUE INDEX threads_number ON threads (project, number);
CREATE INDEX threads_route ON threads (project, route, status) WHERE deleted_at IS NULL;
CREATE INDEX threads_updated ON threads (project, updated_at) WHERE deleted_at IS NULL;

CREATE TABLE replies (
    id          TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL REFERENCES threads (id),
    body        TEXT NOT NULL,
    author_id   TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_kind TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX replies_thread ON replies (thread_id, created_at);

CREATE TABLE screenshots (
    thread_id    TEXT PRIMARY KEY REFERENCES threads (id),
    content_type TEXT NOT NULL,
    data         BLOB NOT NULL
);

CREATE TABLE credentials (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    name         TEXT NOT NULL,
    hash         TEXT NOT NULL UNIQUE,
    scopes       TEXT NOT NULL,
    roles        TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT,
    revoked_at   TEXT,
    last_used_at TEXT
);
