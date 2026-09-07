#!/usr/bin/env python3
"""Parser, state machine, and mutations for board.md — tt's visual planner.

Single source of truth for the board.md file format, shared by
board_server.py (the HTTP API) and the `tt board` CLI subcommands, per
docs/visual-planner-plan.md.
"""

import argparse
import json
import re
import sys
from pathlib import Path

NO_TOPIC = "(no topic)"

LINE_RE = re.compile(r"^- \[(?P<mark>[ xX])\] (?P<id>[A-Za-z0-9_]+): (?P<rest>.*)$")
TOPIC_TAG_RE = re.compile(r"\s*#topic:(?P<topic>\S+)\s*$")
PREDS_TAG_RE = re.compile(r"\s*<-\s*(?P<preds>.+)$")
RELATED_LINK_RE = re.compile(
    r"^(?P<text>.*?)\s*-\s*\[Related:\s*(?P<topic>[^\]]+)\]\(\.\./topics/[^)]+/index\.md\)\s*$"
)
COMPLETED_SUFFIX_RE = re.compile(r"\s*_\(completed:\s*[^)]*\)_\s*$")


class BoardError(ValueError):
    """Raised for invalid board operations (cycle, unknown id, etc.)."""


def _parse_line(line):
    m = LINE_RE.match(line.rstrip("\n"))
    if not m:
        return None
    rest = m.group("rest")

    topic = None
    tm = TOPIC_TAG_RE.search(rest)
    if tm:
        topic = tm.group("topic")
        rest = rest[: tm.start()]

    preds = []
    pm = PREDS_TAG_RE.search(rest)
    if pm:
        preds = [p.strip() for p in pm.group("preds").split(",") if p.strip()]
        rest = rest[: pm.start()]

    return {
        "id": m.group("id"),
        "text": rest.strip(),
        "done": m.group("mark").lower() == "x",
        "preds": preds,
        "topic": topic,
    }


def load(path):
    """Return an ordered list of task dicts from a board.md file."""
    p = Path(path)
    if not p.exists():
        return []
    tasks = []
    for line in p.read_text().splitlines():
        task = _parse_line(line)
        if task is not None:
            tasks.append(task)
    return tasks


def _serialize_line(task):
    parts = [f"- [{'x' if task['done'] else ' '}] {task['id']}: {task['text']}"]
    if task["preds"]:
        parts.append(f" <- {', '.join(task['preds'])}")
    if task.get("topic"):
        parts.append(f" #topic:{task['topic']}")
    return "".join(parts)


def save(path, tasks):
    lines = ["# Board", ""]
    lines.extend(_serialize_line(t) for t in tasks)
    lines.append("")
    Path(path).write_text("\n".join(lines))


def compute_states(tasks):
    """Return {id: 'done'|'blocked'|'readyToStart'} derived from done+preds."""
    done_by_id = {t["id"]: t["done"] for t in tasks}
    states = {}
    for t in tasks:
        if t["done"]:
            states[t["id"]] = "done"
        elif any(not done_by_id.get(p, False) for p in t["preds"]):
            states[t["id"]] = "blocked"
        else:
            states[t["id"]] = "readyToStart"
    return states


def _by_id(tasks):
    return {t["id"]: t for t in tasks}


def _next_id(tasks):
    n = 0
    for t in tasks:
        m = re.match(r"^t(\d+)$", t["id"])
        if m:
            n = max(n, int(m.group(1)))
    return f"t{n + 1}"


def _successors_map(tasks):
    succ = {t["id"]: [] for t in tasks}
    for t in tasks:
        for p in t["preds"]:
            succ.setdefault(p, []).append(t["id"])
    return succ


def _reachable(start, target, succ_map):
    seen = set()
    stack = [start]
    while stack:
        cur = stack.pop()
        if cur == target:
            return True
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(succ_map.get(cur, []))
    return False


def add_task(tasks, text, topic=None, preds=None):
    text = text.strip()
    if not text:
        raise BoardError("Task text cannot be empty")
    preds = preds or []
    ids = _by_id(tasks)
    for p in preds:
        if p not in ids:
            raise BoardError(f"Unknown predecessor id: {p}")
    task_id = _next_id(tasks)
    task = {"id": task_id, "text": text, "done": False, "preds": list(preds), "topic": topic}
    tasks.append(task)
    return task_id


def link(tasks, pred_id, succ_id):
    ids = _by_id(tasks)
    if pred_id not in ids:
        raise BoardError(f"Unknown task id: {pred_id}")
    if succ_id not in ids:
        raise BoardError(f"Unknown task id: {succ_id}")
    if pred_id == succ_id:
        raise BoardError("A task cannot depend on itself")
    succ = ids[succ_id]
    if pred_id in succ["preds"]:
        raise BoardError("That dependency already exists")
    succ_map = _successors_map(tasks)
    if _reachable(succ_id, pred_id, succ_map):
        raise BoardError("That link would create a dependency cycle")
    succ["preds"].append(pred_id)


def unlink(tasks, pred_id, succ_id):
    ids = _by_id(tasks)
    if succ_id not in ids:
        raise BoardError(f"Unknown task id: {succ_id}")
    succ = ids[succ_id]
    if pred_id not in succ["preds"]:
        raise BoardError("That dependency does not exist")
    succ["preds"].remove(pred_id)


def set_done(tasks, task_id, done):
    ids = _by_id(tasks)
    if task_id not in ids:
        raise BoardError(f"Unknown task id: {task_id}")
    task = ids[task_id]
    if done and not task["done"]:
        state = compute_states(tasks)[task_id]
        if state == "blocked":
            raise BoardError("Cannot mark a blocked task done — finish its predecessors first")
    task["done"] = done


def rename(tasks, task_id, text):
    ids = _by_id(tasks)
    if task_id not in ids:
        raise BoardError(f"Unknown task id: {task_id}")
    text = text.strip()
    if not text:
        raise BoardError("Task text cannot be empty")
    ids[task_id]["text"] = text


def delete_task(tasks, task_id, bridge=True):
    ids = _by_id(tasks)
    if task_id not in ids:
        raise BoardError(f"Unknown task id: {task_id}")
    removed = ids[task_id]
    remaining = [t for t in tasks if t["id"] != task_id]
    for t in remaining:
        if task_id in t["preds"]:
            t["preds"] = [p for p in t["preds"] if p != task_id]
            if bridge:
                for p in removed["preds"]:
                    if p not in t["preds"]:
                        t["preds"].append(p)
    tasks[:] = remaining


def splice(tasks, pred_id, succ_id, text, topic=None):
    """Insert a new task between an existing pred -> succ edge."""
    unlink(tasks, pred_id, succ_id)
    new_id = add_task(tasks, text, topic=topic, preds=[pred_id])
    link(tasks, new_id, succ_id)
    return new_id


def to_json(tasks):
    states = compute_states(tasks)
    out = []
    for t in tasks:
        item = dict(t)
        item["state"] = states[t["id"]]
        item["topic"] = t["topic"] or None
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# Import: pull existing checklist items from tasks/ and topics/ into board.md
# ---------------------------------------------------------------------------


def _split_related(text):
    m = RELATED_LINK_RE.match(text)
    if m:
        return m.group("text").strip(), m.group("topic").strip()
    return text.strip(), None


def _checklist_items(path):
    """Yield (text, done) for every '- [ ]'/'- [x]' line in a markdown file."""
    p = Path(path)
    if not p.exists():
        return
    item_re = re.compile(r"^- \[(?P<mark>[ xX])\] (?P<text>.+)$")
    for line in p.read_text().splitlines():
        m = item_re.match(line.strip())
        if m:
            yield m.group("text"), m.group("mark").lower() == "x"


def _worklog_items(path):
    """Yield (text, done) for every '- ' bullet in a tt worklog.md file.

    Worklog entries are plain bullets (tt's `tt log` never writes a
    checkbox) — each logged entry is treated as already-done work. A
    hand-added '- [ ]'/'- [x]' bullet is still honored if present.
    """
    p = Path(path)
    if not p.exists():
        return
    item_re = re.compile(r"^- (?:\[(?P<mark>[ xX])\]\s+)?(?P<text>.+)$")
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line.startswith("- "):
            continue
        m = item_re.match(line)
        if not m or not m.group("text").strip():
            continue
        done = True if m.group("mark") is None else m.group("mark").lower() == "x"
        yield m.group("text"), done


def import_active(root):
    items = []
    for text, done in _checklist_items(Path(root) / "tasks" / "active.md"):
        clean, topic = _split_related(text)
        items.append((clean, topic, done))
    return items


def import_topics(root):
    items = []
    topics_dir = Path(root) / "topics"
    if not topics_dir.is_dir():
        return items
    for topic_dir in sorted(topics_dir.iterdir()):
        if not topic_dir.is_dir() or topic_dir.name == "template":
            continue
        for text, done in _checklist_items(topic_dir / "index.md"):
            items.append((text.strip(), topic_dir.name, done))
    return items


def import_worklogs(root):
    items = []
    topics_dir = Path(root) / "topics"
    if not topics_dir.is_dir():
        return items
    for topic_dir in sorted(topics_dir.iterdir()):
        if not topic_dir.is_dir() or topic_dir.name == "template":
            continue
        for text, done in _worklog_items(topic_dir / "worklog.md"):
            items.append((text.strip(), topic_dir.name, done))
    return items


def import_done(root):
    items = []
    for text, _ in _checklist_items(Path(root) / "tasks" / "done.md"):
        text = COMPLETED_SUFFIX_RE.sub("", text)
        clean, topic = _split_related(text)
        items.append((clean, topic, True))
    return items


def import_all(root, board_path, topics_only=False, skip_done=False):
    """Pull todos from tasks/topics into board.md (adding anything new).

    Only topics/*/index.md and topics/*/worklog.md are two-way sync
    sources: for those, an existing matched task's done-state is
    reconciled to the source on every call (the source -> board half of
    the sync; sync_done_to_source() is the board -> source half). Neither
    tasks/active.md nor tasks/done.md can be written back to in place (tt
    always moves a line from active.md to done.md rather than checking it
    off where it stands — see sync_done_to_source), so those two stay
    one-way "add if new" sources only: reconciling their done-state too
    would silently revert a task marked done on the board back to
    not-done on the very next auto-import.
    """
    tasks = load(board_path)
    by_key = {(t["topic"], t["text"]): t for t in tasks}

    add_only = []
    sync_capable = []
    if not topics_only:
        add_only.extend(import_active(root))
    sync_capable.extend(import_topics(root))
    if not skip_done:
        add_only.extend(import_done(root))
        sync_capable.extend(import_worklogs(root))

    added = 0
    updated = 0

    def add_if_new(text, topic, done):
        nonlocal added
        key = (topic, text)
        if key in by_key:
            return
        task_id = _next_id(tasks)
        new_task = {"id": task_id, "text": text, "done": done, "preds": [], "topic": topic}
        tasks.append(new_task)
        by_key[key] = new_task
        added += 1

    for text, topic, done in add_only:
        if text:
            add_if_new(text, topic, done)

    for text, topic, done in sync_capable:
        if not text:
            continue
        existing = by_key.get((topic, text))
        if existing is None:
            add_if_new(text, topic, done)
        elif existing["done"] != done:
            existing["done"] = done
            updated += 1

    save(board_path, tasks)
    return added, updated


def _rewrite_checklist_line(path, text, done):
    """Find a '- [ ]'/'- [x]'/bare '- ' line whose item text matches `text`
    in a markdown file and rewrite its checkbox to reflect `done`. A
    matched bare bullet (no checkbox at all, e.g. a tt worklog entry) is
    turned into an explicit '- [ ]'/'- [x]' line. Returns True if a line
    was changed.
    """
    p = Path(path)
    if not p.exists():
        return False
    item_re = re.compile(r"^(?P<prefix>\s*-\s*)(?:\[(?P<mark>[ xX])\]\s*)?(?P<rest>.*)$")
    lines = p.read_text().splitlines()
    changed = False
    for i, line in enumerate(lines):
        m = item_re.match(line)
        if not m or m.group("rest").strip() != text.strip():
            continue
        mark = "x" if done else " "
        lines[i] = f"{m.group('prefix')}[{mark}] {m.group('rest').strip()}"
        changed = True
        break
    if changed:
        p.write_text("\n".join(lines) + "\n")
    return changed


def sync_done_to_source(root, tasks, task_id):
    """Best-effort write a task's current done flag back to the line it was
    likely imported from, in its topic's index.md or worklog.md (whichever
    has a matching line first). A no-op if the task has no topic or no
    line matches — e.g. a board-native task, or one whose text was edited
    on the board since import. tasks/active.md is not a sync target: tt
    never marks a line done in place there (`tt done` moves it to
    tasks/done.md instead), so there's no in-place line to write back to.
    """
    task = next((t for t in tasks if t["id"] == task_id), None)
    if not task or not task["topic"]:
        return False
    topic_dir = Path(root) / "topics" / task["topic"]
    if _rewrite_checklist_line(topic_dir / "index.md", task["text"], task["done"]):
        return True
    if _rewrite_checklist_line(topic_dir / "worklog.md", task["text"], task["done"]):
        return True
    return False


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _board_path(args):
    return Path(args.board) if args.board else Path(args.root) / "board.md"


def _cmd_init(args):
    path = _board_path(args)
    if path.exists():
        print(f"Board already exists: {path}")
        return
    save(path, [])
    print(f"Initialized board: {path}")


def _cmd_add(args):
    path = _board_path(args)
    tasks = load(path)
    task_id = add_task(tasks, args.text, topic=args.topic)
    save(path, tasks)
    print(task_id)


def _cmd_link(args):
    path = _board_path(args)
    tasks = load(path)
    link(tasks, args.pred, args.succ)
    save(path, tasks)
    print(f"Linked: {args.pred} -> {args.succ}")


def _cmd_unlink(args):
    path = _board_path(args)
    tasks = load(path)
    unlink(tasks, args.pred, args.succ)
    save(path, tasks)
    print(f"Unlinked: {args.pred} -> {args.succ}")


def _cmd_done(args):
    path = _board_path(args)
    tasks = load(path)
    set_done(tasks, args.id, not args.undo)
    synced = sync_done_to_source(args.root, tasks, args.id)
    save(path, tasks)
    print(f"{'Un-marked' if args.undo else 'Marked'} done: {args.id}")
    if synced:
        print(f"  also updated its source line under topics/")


def _cmd_rm(args):
    path = _board_path(args)
    tasks = load(path)
    delete_task(tasks, args.id, bridge=not args.cut)
    save(path, tasks)
    print(f"Removed: {args.id}")


def _cmd_ls(args):
    path = _board_path(args)
    tasks = load(path)
    states = compute_states(tasks)
    if not tasks:
        print("No tasks on the board.")
        return
    for t in tasks:
        topic = f" [{t['topic']}]" if t["topic"] else ""
        preds = f" <- {', '.join(t['preds'])}" if t["preds"] else ""
        print(f"{t['id']:<6} {states[t['id']]:<13} {t['text']}{topic}{preds}")


def _cmd_import(args):
    added, updated = import_all(
        args.root, _board_path(args), topics_only=args.topics_only, skip_done=args.skip_done
    )
    print(f"Imported {added} new task(s), synced done-state on {updated} existing task(s).")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="board_lib.py")
    parser.add_argument("--root", default=".", help="notes repo root (default: cwd)")
    parser.add_argument("--board", default=None, help="path to board.md (default: <root>/board.md)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init").set_defaults(func=_cmd_init)

    p = sub.add_parser("add")
    p.add_argument("text")
    p.add_argument("--topic", default=None)
    p.set_defaults(func=_cmd_add)

    p = sub.add_parser("link")
    p.add_argument("pred")
    p.add_argument("succ")
    p.set_defaults(func=_cmd_link)

    p = sub.add_parser("unlink")
    p.add_argument("pred")
    p.add_argument("succ")
    p.set_defaults(func=_cmd_unlink)

    p = sub.add_parser("done")
    p.add_argument("id")
    p.add_argument("--undo", action="store_true", help="mark not-done instead")
    p.set_defaults(func=_cmd_done)

    p = sub.add_parser("rm")
    p.add_argument("id")
    p.add_argument("--cut", action="store_true", help="do not bridge predecessors to successors")
    p.set_defaults(func=_cmd_rm)

    sub.add_parser("ls").set_defaults(func=_cmd_ls)

    p = sub.add_parser("import")
    p.add_argument("--topics-only", action="store_true")
    p.add_argument("--skip-done", action="store_true")
    p.set_defaults(func=_cmd_import)

    args = parser.parse_args(argv)
    try:
        args.func(args)
    except BoardError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
