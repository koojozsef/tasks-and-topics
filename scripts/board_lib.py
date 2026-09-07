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


def import_done(root):
    items = []
    for text, _ in _checklist_items(Path(root) / "tasks" / "done.md"):
        text = COMPLETED_SUFFIX_RE.sub("", text)
        clean, topic = _split_related(text)
        items.append((clean, topic, True))
    return items


def import_all(root, board_path, topics_only=False, skip_done=False):
    tasks = load(board_path)
    existing_keys = {(t["topic"], t["text"]) for t in tasks}

    collected = []
    if not topics_only:
        collected.extend(import_active(root))
    collected.extend(import_topics(root))
    if not skip_done:
        collected.extend(import_done(root))

    added = 0
    for text, topic, done in collected:
        key = (topic, text)
        if key in existing_keys or not text:
            continue
        task_id = _next_id(tasks)
        tasks.append({"id": task_id, "text": text, "done": done, "preds": [], "topic": topic})
        existing_keys.add(key)
        added += 1

    save(board_path, tasks)
    return added


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
    save(path, tasks)
    print(f"{'Un-marked' if args.undo else 'Marked'} done: {args.id}")


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
    added = import_all(args.root, _board_path(args), topics_only=args.topics_only, skip_done=args.skip_done)
    print(f"Imported {added} new task(s).")


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
