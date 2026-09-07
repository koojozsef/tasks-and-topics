# Visual Planner — Design Plan

Status: implemented (v1, since revised three times). This document specs a
visual, dependency-graph planner that complements `tt` without disturbing
its existing commands or files. `tt board` is live — see
`scripts/board_lib.py`, `scripts/board_server.py`, and `static/`. §6 and §7
note the one deliberate deviation from the original proposal (a hand-rolled
SVG frontend instead of a vendored Cytoscape.js, since this environment had
no network access to fetch one) and §11/§12 are left as-is for history;
open questions there were resolved as documented inline rather than
re-asked. Since v1: dependencies are now drawn by dragging one task onto
another (§7) rather than a click-based "link mode", edges can be removed
with a click (§7), import (§4) also pulls done, already-logged work out of
each topic's `worklog.md`, done-state now syncs both ways between the
board and `topics/*/index.md`/`worklog.md` specifically (§4), import
now runs automatically — on every GUI load and once at `tt board` startup
— rather than only on request (§4), and the layout dropped per-topic
horizontal swimlane bands entirely in favor of a barycenter-ordered
layered layout that keeps columns as the dependency-rank grid but chooses
each task's row to minimize edge length/crossings, with overpass routing
for edges that skip columns and topic shown as a box stripe instead of a
band (§7).

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
  extension is listed under future work (§10), not required for v1.
- **Storage stays human-readable text**, consistent with the rest of the
  repo (`active.md`, `done.md`, topic `index.md`). Diffs must read cleanly
  in `git diff`.
- **Derived state, not stored state.** Only "done / not done" is a fact the
  user sets. "blocked" vs. "readyToStart" is *computed* from the graph on
  every load — never hand-set — because that's the whole point of the tool
  (see §5). This resolves an ambiguity in "3 states, user can change state
  on GUI": the user toggles done/not-done; ready/blocked follow
  automatically.

## 3. Data format — `board.md`

One new file, `board.md` at the notes-repo root (sibling to `tasks/`,
`topics/`), created by `tt board init`. Kept separate from `active.md`
because the two models don't match: `active.md` is a flat priority list with
no identity/dependencies; the board needs stable IDs and an edge list. They
can be cross-linked later (§10) without forcing a migration now.

Format — reuses the checkbox convention `tt` already uses everywhere:

```markdown
# Board

- [x] t1: Set up repository
- [ ] t2: Write design doc <- t1 #topic:2026-06-23-job-stuffs
- [ ] t3: Implement parser <- t2 #topic:2026-06-23-job-stuffs
- [ ] t4: Write tests <- t2
- [ ] t5: Release <- t3, t4
```

Grammar per line: `- [x|space] <id>: <text>[ <- <id>[, <id>...]][ #topic:<topic-folder>]`

- `[x]` / `[ ]` — done / not done. The only mutable stored flag.
- `<id>` — short token (`t1`, `t2`, ...), assigned by the tool when a task
  is created; stable for the task's lifetime so edges stay valid across
  renames/reordering of lines.
- `<text>` — free text, same as any other `tt` task text.
- `<- a, b` — this task's predecessors ("depends on"). Optional; a task with
  no arrow has no predecessors and starts `readyToStart`.
- `#topic:<topic-folder>` — optional, the topic this task belongs to (same
  folder name `tt` already uses under `topics/`, e.g.
  `2026-06-23-job-stuffs`). Drives which swimlane the task renders in (§7).
  Tasks created directly on the board (not via import) simply omit this tag
  and land in the always-present "(no topic)" swimlane, matching "user can
  add tasks ... to free space" with no forced topic.

Why this shape over YAML/JSON or Graphviz DOT:

- One task = one line = one git diff hunk when its done-state flips —
  exactly how `active.md`/`done.md` already read in history.
- No new syntax family to learn; it's the same `- [ ]` bullet `tt` users
  already type by hand.
- Trivial to parse with a single regex, and trivial to hand-edit in a plain
  text editor if the GUI is unavailable.
- No position/coordinate data is stored (see §7) — the file only ever
  encodes facts (text, done, edges), not layout, so it can't go stale or
  produce noisy diffs from dragging boxes around.

## 4. Import mechanism

Lets a board start from the todos that already exist in the notes repo
instead of everyone retyping them by hand. One-way (source files are never
written back to), idempotent, re-runnable at any time: `tt board import`.

**Sources scanned:**

1. `tasks/active.md` — every `- [ ]` / `- [x]` line under the priority
   sections. If the line carries the existing
   `- [Related: <topic>](../topics/<topic>/index.md)` suffix `tt add task`
   already writes, that topic becomes the imported task's swimlane;
   otherwise it lands in the "(no topic)" swimlane.
2. `topics/*/index.md` — every `- [ ]` / `- [x]` line in the topic file
   (in practice, its "Key Goals" checklist). Swimlane = that topic's folder
   name.
3. `tasks/done.md`, on by default — imported as already-`[x]` tasks, so
   finished work is visible on the board too instead of only ever seeding
   the "already imported" dedup set. `tt board import --skip-done` opts
   out for a leaner board.
4. `topics/*/worklog.md`, also gated by `--skip-done`. Worklog entries
   (written by `tt log`) are plain `- ` bullets, not checklist items —
   `tt log` never writes a checkbox — so each bullet is imported as an
   already-**done** task (a worklog entry is, by construction, a record of
   work that happened), tagged with that topic. A bullet the user hand-
   edited into a `- [ ]`/`- [x]` checklist item is still honored as
   written, checkbox and all.

**Mapping into `board.md`:**

- Imported tasks get **no dependency edges** — the source checklists have
  no notion of ordering between items, so import only ever seeds nodes;
  the user draws `<-` dependencies afterward in the GUI. This matches "no
  dates are needed, only dependency" — dependency is planner-native
  information, never inferred from list order.
- **De-duplication**: a board task is matched against source items by the
  pair `(topic, exact text)`.
  - Known trade-off: editing a task's text on the board afterward breaks
    the match, so a later `tt board import` can't tell it's "the same"
    source item and may re-add it as a duplicate. Acceptable for v1 — the
    fix is deleting the stray duplicate; a content-hash provenance marker
    is listed under deferred work (§10) if this proves annoying.

**Two-way done-state sync, for `index.md` and `worklog.md` only:**

- **Source → board**: on every import, a matched task from `topics/*/
  index.md` or `topics/*/worklog.md` has its done-state *reconciled* to
  the source — if the source line's checkbox differs from the board
  task's `done` flag, the board task is updated to match. So hand-checking
  `- [x]` in a topic's Key Goals or worklog is enough to flip it done on
  the board too, on the next import.
- **Board → source**: the reverse direction happens the moment a task is
  marked (or un-marked) done anywhere — GUI, `POST /api/board/done`, or
  `tt board done`/`undone` — via `board_lib.sync_done_to_source()`: it
  looks for a line with matching text in that task's topic's `index.md`,
  then `worklog.md`, and rewrites its checkbox. A worklog bullet with no
  checkbox at all (the normal `tt log` shape) is turned into an explicit
  `- [ ]`/`- [x]` line the first time it's touched this way. A task with
  no match in either file (board-native, or text edited since import) is
  left alone — best-effort, not an error.
- **`tasks/active.md` and `tasks/done.md` are deliberately excluded** from
  this reconciliation, and stay one-way "add if new" sources only. `tt`
  never checks a box in place in `active.md` — `tt done` *moves* the line
  to `done.md` instead — so there is no in-place line to sync either
  direction for those two files. Early testing surfaced exactly the bug
  this guards against: reconciling *every* source's done-state, active.md
  included, meant marking an active.md-sourced task done on the board got
  silently reverted back to not-done on the very next auto-import (below),
  since active.md's own `[ ]` never changes. Scoping reconciliation to
  only the two files that can actually be written back to fixes that.

**Import now runs automatically**, not just via the CLI/toolbar button:

- On every GUI page load/refresh (`GET /api/board`), before the state is
  returned — so hand-edits to `tasks/`/`topics/` since the last load show
  up without the user having to click "Import".
- Once at `tt board` (`board_server.py` startup), before the server even
  starts listening — so `board.md` is caught up the moment the command is
  run, even if the user never opens the browser (e.g. they only run
  `tt board ls` against it from another terminal).
- The manual `tt board import` CLI command and the toolbar "Import"
  button still exist and do the same full scan — useful to force a sync
  without waiting for a refresh, or to pass `--topics-only`/`--skip-done`.

**CLI:**

```
tt board import                # scan tasks/ + topics/, add anything new,
                                # and sync done-state for index.md/worklog.md
tt board import --topics-only  # skip tasks/active.md
tt board import --skip-done    # skip tasks/done.md
```

Because it's one-way and idempotent, `tt board import` is safe to run
anytime — e.g. as a habit right after `tt add task` — to pull newly added
todos onto the board.

## 5. State rules

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
- Cycles are rejected at edit time (see §7) — the graph is enforced as a DAG
  so "blocked until predecessors done" is always well-defined and can't
  deadlock.

## 6. Architecture (as implemented)

```
tt board  ─▶ scripts/board_server.py (python3, stdlib http.server only)
              │
              ├─ GET  /                 → static/board.html (+ /board.js, /board.css)
              ├─ GET  /api/board        → board_lib.load() + compute_states() → JSON
              └─ POST /api/board/<verb> → add/link/unlink/done/rename/delete/splice/import,
                                           via board_lib.py, then re-saves board.md and
                                           returns the updated board as JSON

Browser (Simple Browser in VS Code, or any local browser) ─▶ http://127.0.0.1:<port>
```

- `board_server.py` uses only `http.server`/`json` from the standard
  library — no pip install, no virtualenv. `board_lib.py` (parser,
  state derivation, cycle detection, bridge-delete, import) is imported
  directly by the server and also invoked as a CLI by `tt board <cmd>`
  (§8), so there is exactly one implementation of the file format and
  the state rules, per the original design goal.
- **Frontend deviates from the original Cytoscape.js proposal**: this
  execution environment has no outbound network access, so vendoring a
  third-party graph library wasn't possible. `static/board.js` is instead
  a small hand-rolled SVG renderer (~350 lines of vanilla JS, no
  libraries at all) — it computes task rank by longest dependency path,
  groups tasks into swimlane bands by topic, and draws boxes/arrows
  directly as SVG elements. This ends up *more* consistent with "keep it
  as simple as possible" than the original plan (genuinely zero
  third-party code to vet, vendor, or update) at the cost of a plainer
  visual style than a mature graph library would give; revisit if a
  richer interaction model (smooth dragging, zoom/pan gestures, curved
  auto-routing) is wanted later and network access to fetch a library is
  available.
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

## 7. GUI interactions

- **Boxes**: one per task, colored/labeled by computed state (e.g. green =
  done, blue = readyToStart, grey = blocked). Blocked boxes are visibly
  non-interactive for "mark done" to make the rule obvious.
- **Toggle done**: click a checkbox/button on the box. `readyToStart` boxes
  can be marked done; `blocked` boxes cannot (mark-done is disabled with a
  tooltip explaining which predecessors are still open).
- **Add on free space**: a toolbar "+ Task" button (or double-click empty
  canvas) creates a new node with no edges — immediately `readyToStart`.
- **Add on a connection line**: right-clicking an edge prompts for new task
  text and splices it into that edge — `a -> b` becomes `a -> new -> b`
  (new task inherits the position in the chain; `a`'s original successor
  is now gated behind the new task too). `POST /api/board/splice`.
- **Draw a dependency (drag and drop)**: press on a task box and drag onto
  another task box; releasing over it makes the *dropped-on* task depend on
  the task you *dragged from* — same direction as the rendered arrows, so
  the gesture reads the same way the result looks. A dashed highlight
  tracks the box currently under the pointer as a live drop-target
  preview, and a dashed line follows the cursor from the source box. A
  press that never moves past a small threshold is just a click (selects
  the task, opens the inspector) — dragging and clicking share one
  `mousedown` handler disambiguated by movement distance. Esc cancels an
  in-progress drag. Rejected server-side (with the reason shown to the
  user) if it would:
  - create a self-loop,
  - create a cycle (DAG check via graph reachability before accepting),
  - duplicate an existing edge.
- **Remove a dependency**: click an arrow (with confirmation) to remove
  that edge outright — the complement to drawing one by drag, and to
  right-click-to-splice on the same arrow.
- **Delete a task**: a confirm dialog, then one of two buttons:
  1. *Delete (bridge chain)* (recommended default) — task's predecessors
     become direct predecessors of its successors, preserving the rest of
     the chain (`a -> x -> b`, delete `x` ⇒ `a -> b`).
  2. *Delete (cut edges)* — just remove the task and all its edges, no
     reconnection.
- **Layout (revised from the original per-swimlane-band design)**: columns
  are strictly the dependency rank (longest path from a root) — the
  "horizontal alignment grid" showing how many dependency layers deep a
  task is, computed over the *full* graph so columns don't shift as
  swimlanes are toggled. Rows are **not** grouped by topic into bands
  anymore — that produced long, frequently-crossing arrows whenever a
  dependency crossed topics (the common case here, since most tasks either
  have no topic or link across them). Instead each column's row order is
  chosen by a barycenter/median heuristic (a standard layered-graph-
  drawing technique, see e.g. the Sugiyama method): a task's row tends
  toward the average row of the neighbors that connect to it, computed in
  a forward pass (by predecessors) then a backward refinement pass (by
  successors) then one more forward pass to settle. Net effect: shorter
  edges, far fewer crossings, and a compact board instead of one that
  grows a full topic-height band per topic regardless of how few tasks are
  in it. Layout is still fully deterministic and recomputed on every
  render, so per §3 no position is persisted; dragging a task is reserved
  for drawing a dependency (above), not for repositioning it.
  - **Edges that skip more than one column** (rank gap > 1) would
    otherwise be drawn as a straight line cutting through the box(es) in
    the skipped column(s) — genuinely hidden/overlapping content, not just
    visually busy. Those are routed instead as a dashed "overpass": a wide
    arc through a reserved headroom strip above row 0, clear of every
    node. Multiple overpasses are staggered across a few height tiers so
    they don't all trace the same arc.
  - **Edges are always drawn on top of (after) node boxes** in paint order
    (`<g id="nodesLayer">` before `<g id="edgesLayer">` in the SVG), so an
    arrow that does cross a box's area is still visible, never invisible
    behind it — the last-resort guarantee behind the overpass routing
    above.
  - **Multiple edges touching the same node are fanned out** across a
    spread of that node's edge (its right side for outgoing edges, left
    side for incoming), ordered by neighbor row, instead of all converging
    through dead-center — cuts down edges overlapping each other right at
    a shared node.
  - **Each edge's click/right-click target is a separate, wide invisible
    "hit" path** layered over the thin (1.5px) visible line — a visible
    line that thin is not a reliable click target on its own; the hit
    path is what actually carries the click-to-unlink and right-click-to-
    splice handlers, and its hover state drives the visible line's
    highlight (via `:has()`).
- **Rename / edit text**: click a box's text to edit inline.
- **Swimlanes, revised**: topic is no longer a row band — it's a colored
  stripe on the left edge of each box (a small deterministic palette keyed
  by topic name), so topic identity stays visible without dictating
  layout. The sidebar's swimlane checklist is unchanged in behavior: every
  distinct topic present among the board's tasks (via the `#topic:` tag
  from §3/§4) gets an entry, with a matching color swatch next to its
  checkbox; tasks with no tag fall under the always-present "(no topic)"
  entry.
- **Swimlane on/off toggle**: unchecking a topic in the sidebar removes
  all of that topic's tasks from the drawing. An edge is only drawn when
  *both* of its endpoints are currently visible, so hiding a topic can
  never leave a dangling arrow pointing at a hidden box. This lets a user
  narrow a big multi-topic board down to just the topics they currently
  care about, while the underlying dependency graph — which may
  legitimately cross topics, e.g. a task in one topic blocking a task in
  another — stays intact in the data regardless of what's currently shown.
  - Swimlane visibility is a *view* preference, not board data: it lives in
    the browser's `localStorage`, never written to `board.md`, consistent
    with §3's rule that the file only stores facts (text, done, edges,
    topic), never presentation state.

## 8. CLI companions (optional but recommended)

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
tt board import [--topics-only|--skip-done]  # see §4
```

These share the same `board.md` parser as the Python server (parser lives
in one place, e.g. `scripts/board_lib.py`, imported by both the HTTP
handler and invoked by `tt` via a thin `python3 -m scripts.board_lib ...`
call from the bash CLI) so there is exactly one source of truth for the
file format, the state-derivation rules, and the import logic.

## 9. Relationship to existing `tt` data

- Additive to `tt` itself: no changes to any existing command, and
  `active.md`/`done.md` are read-only as far as the board is concerned.
  `topics/*/index.md` and `topics/*/worklog.md` are the exception — the
  two-way done-state sync (§4) does write back to them (flipping a
  checkbox to match the board, or turning a bare worklog bullet into an
  explicit one) when a matching line is found there.
- `board.md` lives at repo root next to `tasks/`/`topics/`. A single global
  board (rather than one `board.md` per topic) is now the clear choice for
  v1 given swimlanes (§7): swimlanes already give per-topic grouping and
  on/off filtering *within* one board, including the cross-topic edges a
  set of separate per-topic files couldn't represent at all (a task in one
  topic blocking a task in another).
- `tt apply` (existing `git add -A && commit && push`) already picks up
  `board.md` automatically — no changes needed there. The board GUI writes
  the file on every action (auto-save, no explicit "save" button — matches
  how `tt add task` etc. already commit-worthy state to disk immediately);
  committing/pushing stays a deliberate `tt apply` step, same as today.

## 10. Considered, deferred to later iterations

- **VS Code extension / custom editor** for `board.md` (webview-based,
  no separate server/browser step). More native, but real engineering
  overhead (TypeScript, packaging, `.vsix` install) versus the static
  page + `tt board` approach, which works today with zero VS Code-specific
  code. Worth revisiting if the plain-browser workflow feels clunky in
  practice.
- **Persisted manual layout** (store `{x,y}` per task) if auto-layout proves
  insufficient for large boards.
- **Two-way done-state sync for `tasks/active.md`**: still deliberately
  out of scope (§4) — `tt` has no notion of checking an `active.md` line
  off in place (`tt done` moves it to `done.md`), so syncing a board task
  done would mean replicating that move, not just flipping a checkbox.
  `index.md`/`worklog.md` sync is implemented; this would need its own
  design if wanted.
- **Robust re-import matching** via a stored content-hash/provenance marker
  per imported task, instead of the `(topic, text)` match in §4, if editing
  task text on the board turns out to cause frequent duplicate re-imports
  in practice.
- **Importing meeting-minutes "Action Items" checklists** as an additional
  §4 source, alongside `active.md`/topic files.
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

## 11. Milestones

1. `scripts/board_lib.py` — parser/serializer for the format in §3, state
   derivation (§5), cycle detection, bridge-delete logic. Unit-testable in
   isolation, no server/browser involved.
2. Import functions in `scripts/board_lib.py` (§4) — scan `active.md` /
   `topics/*/index.md` / `done.md`, dedup against existing board tasks,
   append new ones with their `#topic:` tag.
3. `scripts/board_server.py` — stdlib HTTP server wrapping (1)+(2) with
   GET/POST `/api/board` and `POST /api/board/import`, serving the static
   frontend.
4. `static/board.html` + `board.js` — hand-rolled SVG render of the graph
   (see §6) with computed colors, the barycenter layout + topic stripes +
   toggle checklist (§7), click-to-toggle-done, add/delete/link
   interactions from §7, talking to
   the API from (3).
5. `tt board` subcommand wiring in the `tt` bash script (launch server,
   open browser, `init`/`ls`/`import` at minimum; `add`/`link`/`done`/`rm`
   as a fast-follow).
6. README section documenting `tt board` (including `tt board import`),
   mirroring the style of the existing command docs.

## 12. Open questions for confirmation before implementation

- Is the `python3` runtime dependency acceptable, given `tt` is currently
  bash-only? (It's used only for `tt board`; every other command stays
  pure bash.)
- Bridge vs. cut as the *default* delete behavior — plan proposes bridge
  (preserve the chain) as default with cut as an explicit flag.
- Should `tasks/done.md` be imported by default (§4), showing already-done
  work on the board, or should that be opt-in (`--include-done`) instead
  of the currently-proposed opt-out (`--skip-done`)?
- Default swimlane visibility on first load — plan assumes all swimlanes
  start visible (including "(no topic)"); worth confirming that's the
  expected default versus, say, starting collapsed to just "(no topic)".
