# tasks-and-topics

A note taking "app"

---

Lightweight notes workspace using a tasks + topics structure, with a small CLI: `tt`.

> `tt` stands for "tasks and topics". It provides a simple interface for managing notes organized by topics, along with an active task list.

## tt

### User-local install

Run from your folder where `tt` is located:

```bash
chmod +x tt
mkdir -p "$HOME/.local/bin"
ln -sf "$PWD/tt" "$HOME/.local/bin/tt"
```

### Usage

Go to your notes folder and run `tt init` to create the necessary structure. Then you can add tasks and topics, list them, mark tasks as done, and archive topics.

> Your notes folder should be a git repository so you can track changes and history. `tt apply` will commit changes to the repo.

### Commands

```bash
tt init
tt add task "do the job"
tt add task -p high "urgent thing"
tt add topic "job stuffs"
tt ls tasks
tt ls topics
tt done 2
tt mm "weekly sync"
tt archive topic 2026-06-22-job-stuffs
tt board
tt help
```

### What each command does

- `tt init`: creates/ensures `tasks/`, `topics/template/`, `archive/`, and base files.
- `tt add task ...`: adds a checklist item to `tasks/active.md`.
- `tt add topic ...`: creates `topics/YYYY-MM-DD-topic-name/index.md` from template.
- `tt ls tasks`: lists open tasks as numbered items.
- `tt ls topics`: lists current topic folders (excluding `template`).
- `tt done N`: marks the Nth open task as done.
- `tt mm ["meeting title"]`: creates a meeting minutes file. You can select an existing topic, create a new topic, or save into root `meeting-minutes/`.
- `tt archive topic NAME`: moves a topic from `topics/` to `archive/`.
- `tt board`: opens the visual planner (see below).

## tt board

A visual dependency-graph planner for your tasks, on top of a new
`board.md` file — boxes for tasks, arrows for "must finish before". See
[`docs/visual-planner-plan.md`](docs/visual-planner-plan.md) for the full
design.

Run `tt board` (or `tt board open`) from your notes folder. It starts a
small local server, prints a `http://127.0.0.1:<port>` URL, and tries to
open it in a browser (`wslview` on WSL, `xdg-open` on Linux). If neither is
available, open the printed URL yourself — or paste it into VS Code's
**Simple Browser** (`Ctrl+Shift+P` → "Simple Browser: Show") to keep it
next to your notes. Requires `python3` on `PATH` (used only for `tt
board`; every other `tt` command stays pure bash); press `Ctrl+C` to stop
the server.

In the board:

- Every task is a box, colored by state: grey = **blocked**, blue =
  **readyToStart**, green = **done**. A task is blocked until *all* of its
  predecessors are done, then it flips to readyToStart automatically —
  you only ever mark a task done, never its ready/blocked state directly.
- **Double-click** empty canvas to add a task with no predecessors.
- **Right-click** an arrow to insert a new task on that dependency.
- Click a task, then **"Link… (add a predecessor)"**, then click the task
  that should precede it, to draw a dependency (rejected if it would
  create a cycle).
- Click a task to open its panel: edit its text, toggle done (disabled
  while blocked), or delete it — **bridging** the chain (its predecessors
  connect directly to its successors) or **cutting** it (edges just
  removed).
- Tasks are grouped into **swimlanes** by topic; use the checklist in the
  sidebar to show/hide lanes. A task with no topic lives in "(no topic)".

`tt board import` pulls existing checklist items from `tasks/active.md`,
every `topics/*/index.md`, and `tasks/done.md` onto the board as
freestanding tasks (tagged with their topic, no dependencies guessed) —
safe to re-run any time, it only ever adds items it hasn't seen before.
There's also an "Import" button in the toolbar that does the same thing.

The whole board is scriptable, mirroring the GUI:

```bash
tt board init                  # create an empty board.md
tt board add "Write the design doc" --topic 2026-06-23-job-stuffs
tt board link t1 t2            # t2 now depends on t1
tt board unlink t1 t2
tt board done t1                # rejected if t1 is blocked
tt board undone t1
tt board rm t1 --cut           # default is to bridge the chain
tt board ls                    # id, computed state, text
tt board import --skip-done    # or --topics-only
```

`board.md` is plain text (`git diff`-friendly) and is picked up by `tt
apply` like everything else in the notes folder.

### Meeting minutes behavior

- File name format: `YYYY-MM-DD-meeting-title.md`.
- If title is not provided as argument, `tt mm` asks for it.
- Topic selection works like `tt add task`.
- Select existing topic -> saves under `topics/<topic>/meeting-minutes/`.
- Create new topic -> creates topic and saves under that topic's `meeting-minutes/`.
- No topic -> saves under root `meeting-minutes/`.
- A simple template is used with sections for attendees, agenda, discussion, action items, and notes.

## Example structure

In `example-notebook/` you can find the result of following commands. Try it yourself to see how it works!

```bash
mkdir example-notebook
cd example-notebook
tt init
```

Now you can add tasks and topics:



```bash
tt "do the job"  # Adds a new task. Press enter to select no related topic
```

```bash
tt add task -p high "urgent thing"  # Same as above, but with a high priority. Press enter to select no related topic
```

```bash
tt add topic "job stuffs"  # Creates new topic folder `topics/YYYY-MM-DD-job-stuffs/` with an `index.md` file from template.
```

```bash
tt add task "this is related to the **job topic**"  # now select 1) to connect task to topic
```

```bash
tt mm "weekly sync"  # pick 0 for root meeting-minutes/ or select a topic
```

```bash
tt  # lists active tasks
```

Output:

```
1. [High] urgent thing
2. [Medium] this is related to the **job topic** - [Related: 2026-06-23-job-stuffs](../topics/2026-06-23-job-stuffs/index.md)
3. [Medium] do the job
```

```bash
tt log  # adds a worklog entry for today
```