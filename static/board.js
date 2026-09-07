// tt board — hand-rolled SVG dependency graph. No third-party libraries.
(() => {
  "use strict";

  const NO_TOPIC = "(no topic)";
  const COL_W = 220;
  const NODE_W = 180;
  const NODE_H = 50;
  const ROW_GAP = 14;
  const PADDING = 24;
  const OVERPASS_MARGIN = 60; // headroom above row 0 for edges that skip columns to arc through
  const HIDDEN_LANES_KEY = "tt-board-hidden-lanes";
  const TOPIC_COLORS = ["#1565c0", "#2e7d32", "#8e24aa", "#ef6c00", "#00838f", "#ad1457", "#5d4037", "#455a64"];

  const svg = document.getElementById("canvas");
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

  function topicColor(topic) {
    if (!topic || topic === NO_TOPIC) return "#9aa0a6";
    let h = 0;
    for (let i = 0; i < topic.length; i++) h = (h * 31 + topic.charCodeAt(i)) >>> 0;
    return TOPIC_COLORS[h % TOPIC_COLORS.length];
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

  // Layered layout: columns are strictly the dependency rank (the "how many
  // layers deep" grid) — unchanged, always preserved. Rows are NOT grouped
  // by topic anymore (that produced long, overlapping, cross-lane arrows);
  // instead each rank-column's vertical order is chosen by a barycenter
  // heuristic (classic layered-graph-drawing technique) so a task tends to
  // land near the average row of the neighbors that connect to it —
  // shorter edges, fewer crossings. Topic is now shown as a colored stripe
  // on each box instead of a row band; the swimlane checklist still
  // filters visibility, it just no longer dictates row position.
  function computeLayout() {
    const ranks = computeRanks(state.tasks); // over the full graph, so columns don't shift as lanes toggle
    const visibleTasks = state.tasks.filter((t) => !hiddenLanes.has(topicOf(t)));
    const visibleIds = new Set(visibleTasks.map((t) => t.id));
    const byId = new Map(visibleTasks.map((t) => [t.id, t]));

    const byRank = new Map();
    for (const t of visibleTasks) {
      const r = ranks.get(t.id);
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r).push(t.id);
    }
    const maxRank = byRank.size ? Math.max(...byRank.keys()) : 0;

    const sortKey = (id) => {
      const t = byId.get(id);
      return `${t.topic || ""} ${id}`;
    };

    const order = new Map(); // taskId -> position index within its rank column
    for (let r = 0; r <= maxRank; r++) {
      const ids = (byRank.get(r) || []).slice().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
      ids.forEach((id, i) => order.set(id, i));
    }

    function neighbors(id, useSuccessors) {
      if (useSuccessors) {
        return visibleTasks.filter((x) => x.preds.includes(id)).map((x) => x.id);
      }
      return byId.get(id).preds.filter((p) => visibleIds.has(p));
    }

    function sweep(useSuccessors, rankList) {
      for (const r of rankList) {
        const ids = (byRank.get(r) || []).slice();
        const scored = ids.map((id) => {
          const ns = neighbors(id, useSuccessors);
          const bc = ns.length ? ns.reduce((sum, nid) => sum + order.get(nid), 0) / ns.length : order.get(id);
          return { id, bc };
        });
        scored.sort((a, b) => a.bc - b.bc || (sortKey(a.id) < sortKey(b.id) ? -1 : 1));
        scored.forEach((s, i) => order.set(s.id, i));
      }
    }

    const ranksAsc = Array.from({ length: maxRank + 1 }, (_, i) => i);
    sweep(false, ranksAsc.slice(1)); // forward: settle each column by its predecessors' rows
    sweep(true, ranksAsc.slice(0, -1).reverse()); // backward: refine by successors' rows
    sweep(false, ranksAsc.slice(1)); // forward again to settle after the refinement

    const positions = new Map(); // taskId -> {x,y}
    let maxRows = 0;
    for (let r = 0; r <= maxRank; r++) {
      const ids = (byRank.get(r) || []).slice().sort((a, b) => order.get(a) - order.get(b));
      maxRows = Math.max(maxRows, ids.length);
      ids.forEach((id, i) => {
        positions.set(id, { x: PADDING + r * COL_W, y: OVERPASS_MARGIN + PADDING + i * (NODE_H + ROW_GAP) });
      });
    }

    const totalWidth = PADDING * 2 + (maxRank + 1) * COL_W;
    const totalHeight = OVERPASS_MARGIN + PADDING * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP;

    return { positions, ranks, totalWidth, totalHeight };
  }

  // Fan out multiple edges touching the same node across a spread of the
  // node's edge (right side for outgoing, left for incoming) instead of
  // all through dead-center — cuts down edges overlapping each other right
  // at shared nodes. Ordered by the neighbor's own row so the fan doesn't
  // cross itself.
  function fanAnchors(positions, nodeId, neighborIds) {
    const pos = positions.get(nodeId);
    const sorted = neighborIds.slice().sort((a, b) => {
      const pa = positions.get(a), pb = positions.get(b);
      return (pa ? pa.y : 0) - (pb ? pb.y : 0);
    });
    const n = sorted.length;
    const map = new Map();
    sorted.forEach((nid, i) => map.set(nid, pos.y + ((i + 1) / (n + 1)) * NODE_H));
    return map;
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
    const positions = layout.positions;

    edgesLayer.innerHTML = "";
    nodesLayer.innerHTML = "";

    svg.setAttribute("width", Math.max(layout.totalWidth, 400));
    svg.setAttribute("height", Math.max(layout.totalHeight, 200));
    svg.setAttribute("viewBox", `0 0 ${Math.max(layout.totalWidth, 400)} ${Math.max(layout.totalHeight, 200)}`);

    const visibleTasks = state.tasks.filter((t) => positions.has(t.id));
    const visibleIds = new Set(visibleTasks.map((t) => t.id));
    lastPositions = positions;

    // predecessor/successor lists restricted to what's currently visible,
    // used to fan out each node's edge anchor points (see fanAnchors)
    const predsOf = new Map();
    const succsOf = new Map();
    for (const t of visibleTasks) predsOf.set(t.id, t.preds.filter((p) => visibleIds.has(p)));
    for (const t of visibleTasks) {
      for (const p of predsOf.get(t.id)) {
        if (!succsOf.has(p)) succsOf.set(p, []);
        succsOf.get(p).push(t.id);
      }
    }
    const outAnchors = new Map(); // nodeId -> Map(succId -> y), on its right edge
    const inAnchors = new Map(); // nodeId -> Map(predId -> y), on its left edge
    for (const t of visibleTasks) {
      outAnchors.set(t.id, fanAnchors(positions, t.id, succsOf.get(t.id) || []));
      inAnchors.set(t.id, fanAnchors(positions, t.id, predsOf.get(t.id) || []));
    }

    // nodes first (edges are drawn after, i.e. on top, so an arrow is never
    // invisible behind a box — see the <g id="nodesLayer">/"edgesLayer">
    // order in board.html, which is what actually decides paint order)
    for (const t of visibleTasks) {
      const pos = positions.get(t.id);
      const g = el("g", { transform: `translate(${pos.x},${pos.y})`, "data-id": t.id }, nodesLayer);
      const classes = ["node-box", t.state];
      if (t.id === selectedId) classes.push("selected");
      const rect = el("rect", { class: classes.join(" "), width: NODE_W, height: NODE_H }, g);
      el("rect", {
        class: "topic-stripe", x: 0, y: 0, width: 4, height: NODE_H,
        fill: topicColor(t.topic), "pointer-events": "none",
      }, g);
      el("text", { class: "node-text", x: 12, y: 18 }, g).textContent = `${t.id}${t.done ? " ✓" : ""}`;
      const label = el("text", { class: "node-text", x: 12, y: 36 }, g);
      label.textContent = truncate(t.text, 26);
      el("title", {}, g).textContent = `${t.text}\nstate: ${t.state}\ntopic: ${topicOf(t)}`;
      rect.addEventListener("mousedown", (e) => onNodeMouseDown(t.id, e));
    }

    // edges (only when both endpoints are visible), fanned across each
    // node's edge so multiple edges at one node don't all overlap. An edge
    // whose rank gap is more than 1 column would otherwise cut straight
    // through the box(es) in the column(s) it skips — that's routed as an
    // "overpass" arcing through the headroom above row 0 instead.
    let overpassCount = 0;
    for (const t of visibleTasks) {
      for (const p of predsOf.get(t.id)) {
        const a = positions.get(p);
        const b = positions.get(t.id);
        const x1 = a.x + NODE_W, y1 = outAnchors.get(p).get(t.id);
        const x2 = b.x, y2 = inAnchors.get(t.id).get(p);
        const gap = layout.ranks.get(t.id) - layout.ranks.get(p);

        let d, isOverpass = false;
        if (gap <= 1) {
          const midx = (x1 + x2) / 2;
          d = `M ${x1} ${y1} C ${midx} ${y1}, ${midx} ${y2}, ${x2} ${y2}`;
        } else {
          isOverpass = true;
          const topY = 12 + (overpassCount++ % 4) * 12;
          d = `M ${x1} ${y1} C ${x1 + 24} ${topY}, ${x2 - 24} ${topY}, ${x2} ${y2}`;
        }
        el("path", { class: `edge-path${isOverpass ? " overpass" : ""}`, d }, edgesLayer);
        // a fat, invisible companion path carries the click/right-click
        // handlers — the visible line above is only ~1.5px wide, too thin
        // to reliably click on its own
        const hit = el("path", { class: "edge-hit", d }, edgesLayer);
        hit.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          spliceOnEdge(p, t.id);
        });
        hit.addEventListener("click", () => unlinkEdge(p, t.id));
      }
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
      const swatch = document.createElement("span");
      swatch.className = "chip";
      swatch.style.background = topicColor(name);
      label.appendChild(cb);
      label.appendChild(swatch);
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
    if (e.target !== svg) return;
    const text = prompt("New task text:");
    if (!text) return;
    api("add", { text })
      .then((data) => applyBoardState(data, "Added task"))
      .catch((err) => setStatus(err.message, true));
  });

  loadBoard().catch((e) => setStatus(`Failed to load board: ${e.message}`, true));
})();
