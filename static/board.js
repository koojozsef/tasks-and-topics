// tt board — hand-rolled SVG dependency graph. No third-party libraries.
(() => {
  "use strict";

  const NO_TOPIC = "(no topic)";
  const COL_W = 220;
  const NODE_W = 180;
  const NODE_H = 50;
  const ROW_GAP = 14;
  const LANE_HEADER_H = 22;
  const LANE_GAP = 12;
  const PADDING = 24;
  const HIDDEN_LANES_KEY = "tt-board-hidden-lanes";

  const svg = document.getElementById("canvas");
  const lanesLayer = document.getElementById("lanesLayer");
  const edgesLayer = document.getElementById("edgesLayer");
  const nodesLayer = document.getElementById("nodesLayer");
  const swimlaneList = document.getElementById("swimlaneList");
  const statusEl = document.getElementById("status");
  const linkHint = document.getElementById("linkHint");
  const inspector = document.getElementById("inspector");

  const DRAG_THRESHOLD = 6; // px, in SVG user units (1:1 with screen px here)

  let state = { tasks: [], topics: [] };
  let hiddenLanes = loadHiddenLanes();
  let selectedId = null;
  let lastPositions = new Map(); // taskId -> {x,y} from the last render, for drag hit-testing
  let dragState = null; // { sourceId, startX, startY, dragging, targetId, tempLine }

  function loadHiddenLanes() {
    try {
      return new Set(JSON.parse(localStorage.getItem(HIDDEN_LANES_KEY) || "[]"));
    } catch (e) {
      return new Set();
    }
  }

  function saveHiddenLanes() {
    try {
      localStorage.setItem(HIDDEN_LANES_KEY, JSON.stringify([...hiddenLanes]));
    } catch (e) {
      /* localStorage unavailable — swimlane toggles just won't persist */
    }
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", !!isError);
  }

  async function api(action, payload) {
    const res = await fetch(`/api/board/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return data;
  }

  async function loadBoard() {
    const res = await fetch("/api/board");
    state = await res.json();
    render();
  }

  function applyBoardState(data, message) {
    state = data;
    render();
    if (message) setStatus(message, false);
    if (selectedId && !state.tasks.some((t) => t.id === selectedId)) {
      closeInspector();
    } else if (selectedId) {
      renderInspector();
    }
  }

  function topicOf(task) {
    return task.topic || NO_TOPIC;
  }

  function laneOrder() {
    const order = state.topics.slice();
    const idx = order.indexOf(NO_TOPIC);
    if (idx > 0) {
      order.splice(idx, 1);
      order.unshift(NO_TOPIC);
    }
    return order;
  }

  function computeRanks(tasks) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const rank = new Map();
    const visiting = new Set();
    function rankOf(id) {
      if (rank.has(id)) return rank.get(id);
      if (visiting.has(id)) return 0; // guard against a hand-edited cycle
      visiting.add(id);
      const t = byId.get(id);
      let r = 0;
      if (t) {
        for (const p of t.preds) {
          if (byId.has(p)) r = Math.max(r, rankOf(p) + 1);
        }
      }
      visiting.delete(id);
      rank.set(id, r);
      return r;
    }
    tasks.forEach((t) => rankOf(t.id));
    return rank;
  }

  function computeLayout() {
    const ranks = computeRanks(state.tasks);
    const lanes = laneOrder();
    const laneIndex = new Map(lanes.map((l, i) => [l, i]));

    const visibleTasks = state.tasks.filter((t) => !hiddenLanes.has(topicOf(t)));

    // group visible tasks by (lane, rank) to stack them without overlap
    const cellGroups = new Map(); // "lane|rank" -> [taskId,...]
    for (const t of visibleTasks) {
      const key = `${laneIndex.get(topicOf(t))}|${ranks.get(t.id)}`;
      if (!cellGroups.has(key)) cellGroups.set(key, []);
      cellGroups.get(key).push(t.id);
    }
    for (const ids of cellGroups.values()) ids.sort();

    // lane heights, based on the tallest stack anywhere in that lane
    const laneMaxStack = new Map();
    for (const [key, ids] of cellGroups) {
      const lane = Number(key.split("|")[0]);
      laneMaxStack.set(lane, Math.max(laneMaxStack.get(lane) || 0, ids.length));
    }

    const laneTop = new Map();
    let y = PADDING;
    const visibleLaneNames = lanes.filter((l) => !hiddenLanes.has(l) && laneMaxStack.has(laneIndex.get(l)));
    for (const laneName of visibleLaneNames) {
      const li = laneIndex.get(laneName);
      laneTop.set(li, y);
      const stack = laneMaxStack.get(li) || 1;
      const h = LANE_HEADER_H + stack * NODE_H + (stack - 1) * ROW_GAP + PADDING;
      y += h + LANE_GAP;
    }
    const totalHeight = y;

    const positions = new Map(); // taskId -> {x,y,lane}
    let maxRank = 0;
    for (const [key, ids] of cellGroups) {
      const [laneStr, rankStr] = key.split("|");
      const lane = Number(laneStr);
      const rank = Number(rankStr);
      maxRank = Math.max(maxRank, rank);
      const top = laneTop.get(lane);
      ids.forEach((id, i) => {
        positions.set(id, {
          x: PADDING + rank * COL_W,
          y: top + LANE_HEADER_H + i * (NODE_H + ROW_GAP),
          lane,
        });
      });
    }
    const totalWidth = PADDING * 2 + (maxRank + 1) * COL_W;

    return { positions, laneTop, laneIndex, visibleLaneNames, totalWidth, totalHeight };
  }

  function el(tag, attrs, parent) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function truncate(text, n) {
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
  }

  function render() {
    renderSwimlaneList();
    const layout = computeLayout();

    lanesLayer.innerHTML = "";
    edgesLayer.innerHTML = "";
    nodesLayer.innerHTML = "";

    svg.setAttribute("width", Math.max(layout.totalWidth, 400));
    svg.setAttribute("height", Math.max(layout.totalHeight, 200));
    svg.setAttribute("viewBox", `0 0 ${Math.max(layout.totalWidth, 400)} ${Math.max(layout.totalHeight, 200)}`);

    // lane bands + labels
    layout.visibleLaneNames.forEach((name, i) => {
      const li = layout.laneIndex.get(name);
      const top = layout.laneTop.get(li);
      const nextTop = i + 1 < layout.visibleLaneNames.length
        ? layout.laneTop.get(layout.laneIndex.get(layout.visibleLaneNames[i + 1]))
        : layout.totalHeight;
      const h = nextTop - top - LANE_GAP;
      el("rect", {
        class: `lane-band${i % 2 ? " odd" : ""}`,
        x: 2, y: top - 4, width: layout.totalWidth - 4, height: h + LANE_HEADER_H - 6,
      }, lanesLayer);
      el("text", { class: "lane-label", x: 10, y: top + 10 }, lanesLayer).textContent = name;
    });

    const positions = layout.positions;
    const visibleTasks = state.tasks.filter((t) => positions.has(t.id));
    const visibleIds = new Set(visibleTasks.map((t) => t.id));

    lastPositions = positions;

    // edges (only when both endpoints are visible)
    for (const t of visibleTasks) {
      for (const p of t.preds) {
        if (!visibleIds.has(p)) continue;
        const a = positions.get(p);
        const b = positions.get(t.id);
        const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
        const x2 = b.x, y2 = b.y + NODE_H / 2;
        const midx = (x1 + x2) / 2;
        const path = el("path", {
          class: "edge-path",
          d: `M ${x1} ${y1} C ${midx} ${y1}, ${midx} ${y2}, ${x2} ${y2}`,
        }, edgesLayer);
        path.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          spliceOnEdge(p, t.id);
        });
        path.addEventListener("click", () => unlinkEdge(p, t.id));
      }
    }

    // nodes
    for (const t of visibleTasks) {
      const pos = positions.get(t.id);
      const g = el("g", { transform: `translate(${pos.x},${pos.y})`, "data-id": t.id }, nodesLayer);
      const classes = ["node-box", t.state];
      if (t.id === selectedId) classes.push("selected");
      const rect = el("rect", { class: classes.join(" "), width: NODE_W, height: NODE_H }, g);
      el("text", { class: "node-text", x: 8, y: 18 }, g).textContent = `${t.id}${t.done ? " ✓" : ""}`;
      const label = el("text", { class: "node-text", x: 8, y: 36 }, g);
      label.textContent = truncate(t.text, 28);
      el("title", {}, g).textContent = `${t.text}\nstate: ${t.state}`;
      rect.addEventListener("mousedown", (e) => onNodeMouseDown(t.id, e));
    }
  }

  function renderSwimlaneList() {
    swimlaneList.innerHTML = "";
    for (const name of laneOrder()) {
      const li = document.createElement("li");
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !hiddenLanes.has(name);
      cb.addEventListener("change", () => {
        if (cb.checked) hiddenLanes.delete(name);
        else hiddenLanes.add(name);
        saveHiddenLanes();
        render();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" " + name));
      li.appendChild(label);
      swimlaneList.appendChild(li);
    }
  }

  function onNodeClick(id) {
    selectedId = id;
    render();
    renderInspector();
  }

  // --- drag-and-drop dependency drawing -----------------------------------
  // Press on a task and drag onto another task to make the dropped-on task
  // depend on the one you dragged from (an arrow, drawn the same direction
  // as the rendered dependency arrows). A press that never moves past the
  // threshold is treated as a plain click (select the task).

  function svgPoint(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function hitTestNode(x, y, excludeId) {
    for (const [id, pos] of lastPositions) {
      if (id === excludeId) continue;
      if (x >= pos.x && x <= pos.x + NODE_W && y >= pos.y && y <= pos.y + NODE_H) return id;
    }
    return null;
  }

  function onNodeMouseDown(id, evt) {
    if (evt.button !== 0) return;
    evt.preventDefault();
    const p = svgPoint(evt.clientX, evt.clientY);
    dragState = { sourceId: id, startX: p.x, startY: p.y, dragging: false, targetId: null, tempLine: null };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragUp);
  }

  function onDragMove(evt) {
    if (!dragState) return;
    const p = svgPoint(evt.clientX, evt.clientY);
    if (!dragState.dragging) {
      const dist = Math.hypot(p.x - dragState.startX, p.y - dragState.startY);
      if (dist < DRAG_THRESHOLD) return;
      dragState.dragging = true;
      linkHint.hidden = false;
      linkHint.textContent = "Drop on the task this should lead to… (Esc to cancel)";
      const src = lastPositions.get(dragState.sourceId);
      dragState.tempLine = el("line", {
        class: "drag-line",
        x1: src.x + NODE_W / 2, y1: src.y + NODE_H / 2,
        x2: p.x, y2: p.y,
      }, svg);
    }
    dragState.tempLine.setAttribute("x2", p.x);
    dragState.tempLine.setAttribute("y2", p.y);
    const target = hitTestNode(p.x, p.y, dragState.sourceId);
    dragState.targetId = target;
    nodesLayer.querySelectorAll(".node-box.drop-target").forEach((n) => n.classList.remove("drop-target"));
    if (target) {
      const g = nodesLayer.querySelector(`g[data-id="${target}"] rect`);
      if (g) g.classList.add("drop-target");
    }
  }

  function endDrag() {
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragUp);
    if (dragState && dragState.tempLine) dragState.tempLine.remove();
    linkHint.hidden = true;
    nodesLayer.querySelectorAll(".node-box.drop-target").forEach((n) => n.classList.remove("drop-target"));
  }

  function onDragUp() {
    if (!dragState) return;
    const { sourceId, dragging, targetId } = dragState;
    endDrag();
    dragState = null;
    if (!dragging) {
      onNodeClick(sourceId);
      return;
    }
    if (targetId) {
      api("link", { pred: sourceId, succ: targetId })
        .then((data) => applyBoardState(data, `Linked ${sourceId} -> ${targetId}`))
        .catch((e) => setStatus(e.message, true));
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dragState) {
      endDrag();
      dragState = null;
    }
  });

  function unlinkEdge(pred, succ) {
    if (!confirm(`Remove the dependency ${pred} -> ${succ}?`)) return;
    api("unlink", { pred, succ })
      .then((data) => applyBoardState(data, "Removed dependency"))
      .catch((e) => setStatus(e.message, true));
  }

  function closeInspector() {
    selectedId = null;
    inspector.hidden = true;
    render();
  }

  function renderInspector() {
    const t = state.tasks.find((x) => x.id === selectedId);
    if (!t) {
      inspector.hidden = true;
      return;
    }
    inspector.hidden = false;
    document.getElementById("inspTitleId").textContent = t.id;
    document.getElementById("inspText").value = t.text;
    const badge = document.getElementById("inspState");
    badge.textContent = t.state;
    badge.className = `state-badge ${t.state}`;

    const reason = document.getElementById("inspBlockedReason");
    const doneBox = document.getElementById("inspDone");
    doneBox.checked = t.done;
    if (t.state === "blocked") {
      const openPreds = t.preds.filter((p) => {
        const pt = state.tasks.find((x) => x.id === p);
        return pt && !pt.done;
      });
      reason.hidden = false;
      reason.textContent = `Waiting on: ${openPreds.join(", ") || "unknown"}`;
      doneBox.disabled = true;
    } else {
      reason.hidden = true;
      doneBox.disabled = false;
    }

    document.getElementById("inspTopic").textContent = `Topic: ${topicOf(t)}`;
  }

  document.getElementById("closeInspector").addEventListener("click", closeInspector);

  document.getElementById("inspSave").addEventListener("click", () => {
    const t = state.tasks.find((x) => x.id === selectedId);
    if (!t) return;
    const text = document.getElementById("inspText").value;
    api("rename", { id: t.id, text })
      .then((data) => applyBoardState(data, "Saved"))
      .catch((e) => setStatus(e.message, true));
  });

  document.getElementById("inspDone").addEventListener("change", (e) => {
    const t = state.tasks.find((x) => x.id === selectedId);
    if (!t) return;
    api("done", { id: t.id, done: e.target.checked })
      .then((data) => applyBoardState(data, e.target.checked ? "Marked done" : "Marked not done"))
      .catch((err) => {
        setStatus(err.message, true);
        e.target.checked = t.done;
      });
  });

  document.getElementById("inspDeleteBridge").addEventListener("click", () => {
    if (!selectedId) return;
    if (!confirm(`Delete ${selectedId} and reconnect its predecessors to its successors?`)) return;
    api("delete", { id: selectedId, bridge: true })
      .then((data) => applyBoardState(data, "Deleted (bridged)"))
      .catch((e) => setStatus(e.message, true));
  });

  document.getElementById("inspDeleteCut").addEventListener("click", () => {
    if (!selectedId) return;
    if (!confirm(`Delete ${selectedId} and remove its edges without reconnecting?`)) return;
    api("delete", { id: selectedId, bridge: false })
      .then((data) => applyBoardState(data, "Deleted (cut)"))
      .catch((e) => setStatus(e.message, true));
  });

  function spliceOnEdge(pred, succ) {
    const text = prompt("New task to insert on this dependency:");
    if (!text) return;
    api("splice", { pred, succ, text })
      .then((data) => applyBoardState(data, "Inserted task on the dependency"))
      .catch((e) => setStatus(e.message, true));
  }

  document.getElementById("addTaskBtn").addEventListener("click", () => {
    const text = prompt("New task text:");
    if (!text) return;
    api("add", { text })
      .then((data) => applyBoardState(data, "Added task"))
      .catch((e) => setStatus(e.message, true));
  });

  document.getElementById("importBtn").addEventListener("click", () => {
    const before = state.tasks.length;
    api("import", {})
      .then((data) => applyBoardState(data, `Imported ${data.tasks.length - before} new task(s)`))
      .catch((e) => setStatus(e.message, true));
  });

  svg.addEventListener("dblclick", (e) => {
    const isBackground = e.target === svg || e.target.classList.contains("lane-band");
    if (!isBackground) return;
    const text = prompt("New task text:");
    if (!text) return;
    api("add", { text })
      .then((data) => applyBoardState(data, "Added task"))
      .catch((err) => setStatus(err.message, true));
  });

  loadBoard().catch((e) => setStatus(`Failed to load board: ${e.message}`, true));
})();
