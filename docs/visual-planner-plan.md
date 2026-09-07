# Visual Planner — Design Plan

Status: proposal, not yet implemented. This document specs a visual, dependency-graph
planner that complements `tt` without disturbing its existing commands or files.

## 1. Goal

Give `tt` users a board view where tasks are boxes, arrows between boxes mean
"must finish before", and a task's state (blocked / ready / done) is computed
from that graph instead of hand-maintained. Everything stays local, offline,
plain-text, and git-friendly — same rules the rest of `tt` already follows.

## 2. Design principles

- **Linux/WSL first.** No GUI toolkit, no `.exe`, nothing that assumes a
  desktop session exists. The planner runs as a local web page reached
  through a browser — on native Linux that's any browser; on WSL it's the
  Windows browser talking to `localhost` (WSL2 forwards `localhost`
  automatically, so nothing special is required on the Windows side).
- **Zero install step.** No `npm install`, no build pipeline, no compiled
  extension. Everything needed ships as static files inside the repo.
  Only runtime dependency: `python3` (stdlib only), which is preinstalled on
  essentially every Linux distro and every WSL Ubuntu image `tt` already
  targets.
- **VS Code friendly, not VS Code required.** `tt board` opens a normal
  `http://127.0.0.1:PORT` URL. VS Code users can open it with
  **Simple Browser** (`Ctrl+Shift+P` → "Simple Browser: Show") right next to
  their markdown notes, with no extension to install. A dedicated VS Code
  extension is listed under future work (§9), not required for v1.
- **Storage stays human-readable text**, consistent with the rest of the
  repo (`active.md`, `done.md`, topic `index.md`). Diffs must read cleanly
  in `git diff`.
- **Derived state, not stored state.** Only "done / not done" is a fact the
  user sets. "blocked" vs. "readyToStart" is *computed* from the graph on
  every load — never hand-set — because that's the whole point of the tool
  (see §4). This resolves an ambiguity in "3 states, user can change state
  on GUI": the user toggles done/not-done; ready/blocked follow
  automatically.

## 3. Data format — `board.md`

One new file, `board.md` at the notes-repo root (sibling to `tasks/`,
`topics/`), created by `tt board init`. Kept separate from `active.md`
because the two models don't match: `active.md` is a flat priority list with
no identity/dependencies; the board needs stable IDs and an edge list. They
can be cross-linked later (§9) without forcing a migration now.

Format — reuses the checkbox convention `tt` already uses everywhere:

```markdown
# Board

- [x] t1: Set up repository
- [ ] t2: Write design doc <- t1
- [ ] t3: Implement parser <- t2
- [ ] t4: Write tests <- t2
- [ ] t5: Release <- t3, t4
```

Grammar per line: `- [x|space] <id>: <text>[ <- <id>[, <id>...]]`

- `[x]` / `[ ]` — done / not done. The only mutable stored flag.
- `<id>` — short token (`t1`, `t2`, ...), assigned by the tool when a task
  is created; stable for the task's lifetime so edges stay valid across
  renames/reordering of lines.
- `<text>` — free text, same as any other `tt` task text.
- `<- a, b` — this task's predecessors ("depends on"). Optional; a task with
  no arrow has no predecessors and starts `readyToStart`.

Why this shape over YAML/JSON or Graphviz DOT:

- One task = one line = one git diff hunk when its done-state flips —
  exactly how `active.md`/`done.md` already read in history.
- No new syntax family to learn; it's the same `- [ ]` bullet `tt` users
  already type by hand.
- Trivial to parse with a single regex, and trivial to hand-edit in a plain
  text editor if the GUI is unavailable.
- No position/coordinate data is stored (see §6) — the file only ever
  encodes facts (text, done, edges), not layout, so it can't go stale or
  produce noisy diffs from dragging boxes around.

## 4. State rules

```
done        := stored "[x]" flag
blocked     := NOT done AND EXISTS predecessor p WHERE p.done == false
readyToStart:= NOT done AND NOT blocked
```

- A task with zero predecessors is `readyToStart` from the start.
- Marking a task done in the GUI (or by hand-editing `[ ]` → `[x]`) can flip
  some successors from `blocked` to `readyToStart` on the next reload — that
  transition is exactly the "chain" behavior requested.
- Un-marking a done task (done → not done) must correctly re-block any
  successor whose other predecessors aren't all done — recomputed the same
  way, no special-casing needed since state is never stored, only derived.
- Cycles are rejected at edit time (see §6) — the graph is enforced as a DAG
  so "blocked until predecessors done" is always well-defined and can't
  deadlock.

## 5. Architecture

```
tt board  ─▶ scripts/board_server.py (python3, stdlib http.server only)
              │
              ├─ GET  /            → serves static/board.html + board.js (vendored Cytoscape.js)
              ├─ GET  /api/board   → parses board.md → JSON {tasks, edges, computed state}
              └─ POST /api/board   → validates + serializes JSON back → board.md (atomic write)

Browser (Simple Browser in VS Code, or any local browser) ─▶ http://127.0.0.1:<port>
```

- `board_server.py` uses only `http.server`/`json` from the standard
  library — no pip install, no virtualenv.
- The frontend is one static HTML page plus a vendored copy of
  **Cytoscape.js** (single-file MIT-licensed graph library,
  `third_party/cytoscape.min.js`, checked into the repo so the tool works
  fully offline — no CDN dependency, which matters for WSL environments
  with restricted network policies). Layout uses Cytoscape's **built-in**
  `breadthfirst` directed layout, so no extra plugin files are needed.
- `tt board` starts the server on a free localhost port, prints the URL,
  and best-effort opens a browser:
  `wslview` (WSL, if `wslu` present) → `xdg-open` (Linux) → else just print
  the URL for the user to open manually / paste into Simple Browser. Never
  hard-fails if no opener is found.
- The server binds to `127.0.0.1` only — single-user local tool, no auth
  needed, not reachable off the host.
- Considered and rejected: doing reads/writes purely client-side via the
  browser's File System Access API (no server at all). Rejected because
  it's Chromium-only (no Firefox), behaves inconsistently on repeat
  launches, and doesn't reliably work with VS Code's embedded Simple
  Browser. The small Python server is a handful of lines and works
  everywhere consistently — worth the trade for "simple to use" over
  "simplest possible code".

## 6. GUI interactions

- **Boxes**: one per task, colored/labeled by computed state (e.g. green =
  done, blue = readyToStart, grey = blocked). Blocked boxes are visibly
  non-interactive for "mark done" to make the rule obvious.
- **Toggle done**: click a checkbox/button on the box. `readyToStart` boxes
  can be marked done; `blocked` boxes cannot (mark-done is disabled with a
  tooltip explaining which predecessors are still open).
- **Add on free space**: a toolbar "+ Task" button (or double-click empty
  canvas) creates a new node with no edges — immediately `readyToStart`.
- **Add on a connection line**: hovering an edge shows a "+" affordance;
  clicking it splices a new task into that edge — `a -> b` becomes
  `a -> new -> b` (new task inherits the position in the chain; `a`'s
  original successor is now gated behind the new task too).
- **Draw a dependency**: drag from one box's edge-handle to another to add
  `<- ` predecessor. Rejected client-side (with a message) if it would:
  - create a self-loop,
  - create a cycle (DAG check via graph reachability before accepting),
  - duplicate an existing edge.
- **Delete a task**: confirmation, then two reconnect choices offered:
  1. *Bridge* (default) — task's predecessors become direct predecessors of
     its successors, preserving the rest of the chain (`a -> x -> b`,
     delete `x` ⇒ `a -> b`).
  2. *Cut* — just remove the task and all its edges, no reconnection.
- **Layout / dragging**: boxes auto-arrange (breadthfirst by dependency
  depth) on load. Users may drag a box to declutter a view, but per §3 no
  position is persisted — a reload/relayout is deterministic and always
  reflects the same graph. (Persisting manual layout is a possible v2 —
  see §9 — deliberately deferred so the file format stays pure data.)
- **Rename / edit text**: click a box's text to edit inline.

## 7. CLI companions (optional but recommended)

For consistency with how every other `tt` feature is scriptable, and so the
board can be edited without a browser open (e.g. over SSH):

```
tt board init                 # creates board.md
tt board                      # alias for: tt board open
tt board open                 # starts server, prints/opens URL
tt board add "Task text"      # appends a readyToStart task, prints its id
tt board link <id> <- <id>    # add a dependency edge (with cycle check)
tt board unlink <id> <- <id>  # remove a dependency edge
tt board done <id>            # mark a task done (rejects if blocked)
tt board rm <id> [--bridge]   # delete a task, default bridges edges
tt board ls                   # prints tasks with computed state, tt-style
```

These share the same `board.md` parser as the Python server (parser lives
in one place, e.g. `scripts/board_lib.py`, imported by both the HTTP
handler and invoked by `tt` via a thin `python3 -m scripts.board_lib ...`
call from the bash CLI) so there is exactly one source of truth for the
file format and the state-derivation rules.

## 8. Relationship to existing `tt` data

- Fully additive: no changes to `active.md`, `done.md`, topics, or existing
  commands.
- `board.md` lives at repo root next to `tasks/`/`topics/`. A per-topic
  board (`topics/<topic>/board.md`) is possible later if one global board
  proves too coarse for users working across many topics at once (v1 ships
  with a single global board to keep scope small).
- `tt apply` (existing `git add -A && commit && push`) already picks up
  `board.md` automatically — no changes needed there. The board GUI writes
  the file on every action (auto-save, no explicit "save" button — matches
  how `tt add task` etc. already commit-worthy state to disk immediately);
  committing/pushing stays a deliberate `tt apply` step, same as today.

## 9. Considered, deferred to later iterations

- **VS Code extension / custom editor** for `board.md` (webview-based,
  no separate server/browser step). More native, but real engineering
  overhead (TypeScript, packaging, `.vsix` install) versus the static
  page + `tt board` approach, which works today with zero VS Code-specific
  code. Worth revisiting if the plain-browser workflow feels clunky in
  practice.
- **Persisted manual layout** (store `{x,y}` per task) if auto-layout proves
  insufficient for large boards.
- **Per-topic boards** instead of one global board.
- **Linking board tasks to topics/meeting-minutes**, mirroring
  `tt add task`'s "select related topic" flow.
- **Export to static SVG/PNG** (e.g. via `dot`/Graphviz if present) for
  sharing a snapshot outside the tool.
- **External-edit conflict detection**: if `board.md` is hand-edited in
  VS Code while the GUI is open, the server should detect the file's mtime
  changed since last read and warn on next save rather than silently
  clobbering. Straightforward to add; noted so it isn't forgotten, not
  needed for a first working version.
- **Undo/redo** in the GUI — every action already writes straight to a git
  working tree, so `git diff`/`git checkout -- board.md` is the undo
  mechanism for now; an in-app undo stack is a nice-to-have, not required.

## 10. Milestones

1. `scripts/board_lib.py` — parser/serializer for the format in §3, state
   derivation (§4), cycle detection, bridge-delete logic. Unit-testable in
   isolation, no server/browser involved.
2. `scripts/board_server.py` — stdlib HTTP server wrapping (1) with
   GET/POST `/api/board`, serving the static frontend.
3. `static/board.html` + `board.js` — Cytoscape.js render of the graph
   with computed colors, click-to-toggle-done, add/delete/link
   interactions from §6, talking to the API from (2).
4. `tt board` subcommand wiring in the `tt` bash script (launch server,
   open browser, `init`/`ls` at minimum; `add`/`link`/`done`/`rm` as a
   fast-follow).
5. README section documenting `tt board`, mirroring the style of the
   existing command docs.

## 11. Open questions for confirmation before implementation

- Is a single global `board.md` acceptable for v1, or is per-topic
  scoping needed immediately?
- Is the `python3` runtime dependency acceptable, given `tt` is currently
  bash-only? (It's used only for `tt board`; every other command stays
  pure bash.)
- Bridge vs. cut as the *default* delete behavior — plan proposes bridge
  (preserve the chain) as default with cut as an explicit flag.
