# Family Tree

Browser app for building a family tree, with a zero-dependency Node server
that serves it and persists the tree to a JSON file.

## Run

```bash
cd family_tree
npm start          # or: node server.js
```

Then open <http://127.0.0.1:4173>.

The app must be served by `server.js`. It serves both the static files and the
`/api/tree` endpoint, so everything works from a single origin.

Opening `index.html` directly from the filesystem — or serving the folder with
a generic static server such as `python3 -m http.server` or the VS Code Live
Server extension — loads the UI fine, but every save fails: those servers have
no `/api/tree` route, and most implement only `GET`/`HEAD`, so the save request
comes back as `501 Unsupported method ('PUT')` or `404`. Because autosave
retries after each edit, the **Unsaved changes** badge then never clears. If you
see a 501 on `PUT /api/tree`, check what is actually bound to the port — the
request is not reaching `server.js`.

## Environment

| Variable | Default     | Meaning              |
| -------- | ----------- | -------------------- |
| `PORT`   | `4173`      | Listening port       |
| `HOST`   | `127.0.0.1` | Bind address         |

The default bind is loopback-only; the server has **no authentication**, so
only expose it beyond localhost behind something that does.

## Storage

```
family_tree/data/family-tree.json      <- current tree
family_tree/data/backups/              <- last 10 versions, timestamped
```

The file is written to a temp file and then renamed over the target, so an
interrupted save cannot leave a half-written file. The previous version is
copied into `backups/` first, because a save is a full overwrite. `data/` is
gitignored — it is runtime data, not source.

## API

### `GET /api/tree`

```json
{ "members": [], "savedAt": "2026-01-01T00:00:00.000Z", "empty": false }
```

`empty: true` means nothing has been saved yet (`200`, not `404`). A stored
file that is unreadable answers `500` rather than reporting an empty tree —
otherwise the client would be invited to overwrite a file it could not read.

### `PUT /api/tree` (`POST` also accepted)

Body: `{ "members": [ ... ] }`. Responds:

```json
{ "status": "saved", "savedAt": "...", "count": 12, "file": "data/family-tree.json" }
```

The server re-validates the payload from scratch rather than trusting the
client, and **rejects** instead of coercing, so a malformed request cannot
overwrite a good file. `400` with an explanatory `error` on: non-JSON body, a
missing `members` array, a member without an `id`, a duplicate `id`, or a
`spouseIds` / `parentIds` / `childIds` entry pointing at an id that does not
exist. Bodies over 5 MB get `413`.

Writes are serialised through an internal queue — overlapping saves cannot
interleave their write/rename steps.

## In the UI

**Save to Server** / **Load from Server** sit in the JSON panel inside the
drawer. Save persists the *rendered* tree, not the textarea, since the
textarea may hold edits that were never applied. Load asks for confirmation
before replacing the current tree, and refuses when the server has nothing
saved rather than wiping the tree in exchange for an empty one.

Changes auto-save. Adding, editing and deleting members, applying or importing
JSON, and Reset all raise an **Unsaved changes** badge and schedule a write
about a second later; a burst of edits is coalesced into a single request. The
badge clears once the server confirms, and stays up if the save fails or the
server is unreachable, with the reason shown in the status line. The browser
warning on close/reload remains as a backstop for that window.

Autosaves `PUT /api/tree?autosave=1`, which skips the backup snapshot — they
fire constantly, and a 10-slot ring filled by one session's edits preserves
nothing useful. Validation and the atomic write are identical either way.
**Save to Server** still snapshots, so the backup folder holds deliberate
versions only.
