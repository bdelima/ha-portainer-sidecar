// Portainer Action Dashboard frontend.
//
// Reads the three HA tracking sensors (sensor.portainer_updates_pending,
// sensor.portainer_container_trouble, sensor.portainer_stale_devices) via
// this app's own backend, which proxies HA's REST API, and renders a real
// multi-select table + batch action bar. See main.py for the API this
// talks to, and portainer-ha-container-management-design.md ("Tracking
// sensors" and "Webpage dashboard" sections) for how this fits with the
// HA-side automations/scripts it depends on.

const REFRESH_MS = 15000;

const state = {
  activeTab: "updates",
  data: { updates: { count: 0, items: [] }, trouble: { count: 0, items: [] }, stale: { count: 0, items: [] } },
  selection: { updates: new Set(), stale: new Set() },
  haBaseUrl: "",
};

const el = (id) => document.getElementById(id);

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    state.haBaseUrl = cfg.ha_base_url || "";
  } catch (e) {
    // Non-fatal -- just means "open in HA" links won't be built.
  }
}

async function loadActionItems() {
  try {
    const res = await fetch("/api/action-items");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    pruneSelection();
    render();
    el("last-updated").textContent = "Updated " + new Date().toLocaleTimeString();
  } catch (e) {
    el("last-updated").textContent = "Refresh failed — will retry";
    console.error(e);
  }
}

// Drop selected ids that are no longer present (e.g. installed/deleted elsewhere).
function pruneSelection() {
  const updateIds = new Set(state.data.updates.items.map((i) => i.entity));
  for (const id of [...state.selection.updates]) {
    if (!updateIds.has(id)) state.selection.updates.delete(id);
  }
  const staleIds = new Set(state.data.stale.items.map((i) => staleDeviceId(i)).filter(Boolean));
  for (const id of [...state.selection.stale]) {
    if (!staleIds.has(id)) state.selection.stale.delete(id);
  }
}

function staleDeviceId(item) {
  return item?.device_id || null;
}

function render() {
  el("count-updates").textContent = state.data.updates.count;
  el("count-trouble").textContent = state.data.trouble.count;
  el("count-stale").textContent = state.data.stale.count;

  const totalCount = state.data.updates.count + state.data.trouble.count + state.data.stale.count;
  el("empty-state").hidden = totalCount !== 0;
  for (const panel of document.querySelectorAll(".panel")) {
    panel.hidden = totalCount === 0 || panel.dataset.panel !== state.activeTab;
  }

  renderUpdatesRows();
  renderTroubleRows();
  renderStaleRows();
  renderActionBar();
}

function emptyRow(colspan, text) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = colspan;
  td.className = "empty-row";
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

function renderUpdatesRows() {
  const tbody = el("rows-updates");
  tbody.innerHTML = "";
  const items = state.data.updates.items;
  if (items.length === 0) {
    tbody.appendChild(emptyRow(3, "No pending updates."));
    return;
  }
  for (const item of items) {
    const tr = document.createElement("tr");
    if (state.selection.updates.has(item.entity)) tr.classList.add("selected");

    const tdCheck = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selection.updates.has(item.entity);
    cb.addEventListener("change", () => {
      toggleSelection("updates", item.entity, cb.checked);
    });
    tdCheck.appendChild(cb);

    const tdName = document.createElement("td");
    tdName.innerHTML = `<div class="row-name">${escapeHtml(item.name)}</div>`;

    const tdStatus = document.createElement("td");
    const installBtn = document.createElement("button");
    installBtn.className = "row-action-btn";
    installBtn.textContent = "Install";
    installBtn.addEventListener("click", () => installUpdates([item.entity]));
    tdStatus.innerHTML = `<span class="row-secondary">Update available</span>`;
    tdStatus.appendChild(installBtn);

    tr.append(tdCheck, tdName, tdStatus);
    tbody.appendChild(tr);
  }
}

function renderTroubleRows() {
  const tbody = el("rows-trouble");
  tbody.innerHTML = "";
  const items = state.data.trouble.items;
  if (items.length === 0) {
    tbody.appendChild(emptyRow(2, "No containers in trouble."));
    return;
  }
  for (const item of items) {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.innerHTML = `<div class="row-name">${escapeHtml(item.name)}</div>`;
    const tdStatus = document.createElement("td");
    tdStatus.innerHTML = `<span class="row-secondary">${escapeHtml(item.secondary_info || "")}</span>`;
    if (state.haBaseUrl && item.entity) {
      const link = document.createElement("a");
      link.href = `${state.haBaseUrl}/history?entity_id=${encodeURIComponent(item.entity)}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.className = "row-action-btn";
      link.style.textDecoration = "none";
      link.textContent = "View";
      tdStatus.appendChild(link);
    }
    tr.append(tdName, tdStatus);
    tbody.appendChild(tr);
  }
}

function renderStaleRows() {
  const tbody = el("rows-stale");
  tbody.innerHTML = "";
  const items = state.data.stale.items;
  if (items.length === 0) {
    tbody.appendChild(emptyRow(3, "No stale devices."));
    return;
  }
  for (const item of items) {
    const deviceId = staleDeviceId(item);
    const tr = document.createElement("tr");
    if (deviceId && state.selection.stale.has(deviceId)) tr.classList.add("selected");

    const tdCheck = document.createElement("td");
    if (deviceId) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.selection.stale.has(deviceId);
      cb.addEventListener("change", () => toggleSelection("stale", deviceId, cb.checked));
      tdCheck.appendChild(cb);
    }

    const tdName = document.createElement("td");
    tdName.innerHTML = `<div class="row-name">${escapeHtml(item.name)}</div>`;

    const tdStatus = document.createElement("td");
    tdStatus.innerHTML = `<span class="row-secondary">${escapeHtml(item.secondary_info || "")}</span>`;
    const navPath = item?.navigation_path;
    if (state.haBaseUrl && navPath) {
      const link = document.createElement("a");
      link.href = `${state.haBaseUrl}${navPath}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.className = "row-action-btn";
      link.style.textDecoration = "none";
      link.textContent = "Review";
      tdStatus.appendChild(link);
    }

    tr.append(tdCheck, tdName, tdStatus);
    tbody.appendChild(tr);
  }
}

function toggleSelection(category, id, checked) {
  if (checked) state.selection[category].add(id);
  else state.selection[category].delete(id);
  render();
}

function renderActionBar() {
  const bar = el("action-bar");
  const category = state.activeTab;
  if (category === "trouble") {
    bar.hidden = true;
    return;
  }
  const sel = state.selection[category];
  if (!sel || sel.size === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  el("selection-count").textContent = `${sel.size} selected`;
  const btn = el("action-btn");
  btn.className = category === "stale" ? "primary-btn danger" : "primary-btn";
  btn.textContent = category === "stale" ? `Delete ${sel.size} device(s)` : `Install ${sel.size} update(s)`;
  btn.onclick = () => {
    if (category === "stale") confirmDeleteSelected();
    else installUpdates([...sel]);
  };
}

function selectAll(category, checked) {
  const items = state.data[category].items;
  if (checked) {
    for (const item of items) {
      const id = category === "stale" ? staleDeviceId(item) : item.entity;
      if (id) state.selection[category].add(id);
    }
  } else {
    state.selection[category].clear();
  }
  render();
}

async function installUpdates(entityIds) {
  if (entityIds.length === 0) return;
  showToast(`Installing ${entityIds.length} update(s)…`);
  try {
    const res = await fetch("/api/actions/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_entities: entityIds }),
    });
    const result = await res.json();
    for (const id of entityIds) state.selection.updates.delete(id);
    if (result.errors && result.errors.length > 0) {
      showToast(`Done with ${result.errors.length} error(s) — check backend logs`);
    } else {
      showToast(`Installed ${entityIds.length} update(s)`);
    }
  } catch (e) {
    showToast("Install failed — see console");
    console.error(e);
  }
  loadActionItems();
}

function confirmDeleteSelected() {
  const ids = [...state.selection.stale];
  if (ids.length === 0) return;
  el("confirm-text").textContent =
    `Permanently delete ${ids.length} stale device${ids.length === 1 ? "" : "s"}? This cannot be undone.`;
  el("confirm-dialog").hidden = false;
  el("confirm-ok").onclick = () => {
    el("confirm-dialog").hidden = true;
    deleteStaleDevices(ids);
  };
  el("confirm-cancel").onclick = () => {
    el("confirm-dialog").hidden = true;
  };
}

async function deleteStaleDevices(deviceIds) {
  showToast(`Deleting ${deviceIds.length} device(s)…`);
  try {
    const res = await fetch("/api/actions/delete-stale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: deviceIds }),
    });
    const result = await res.json();
    for (const id of deviceIds) state.selection.stale.delete(id);
    if (result.errors && result.errors.length > 0) {
      showToast(`Done with ${result.errors.length} error(s) — check backend logs`);
    } else {
      showToast(`Deleted ${deviceIds.length} device(s)`);
    }
  } catch (e) {
    showToast("Delete failed — see console");
    console.error(e);
  }
  loadActionItems();
}

let toastTimer = null;
function showToast(text) {
  const toast = el("toast");
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 4000);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function setupTabs() {
  for (const btn of document.querySelectorAll(".tab")) {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === btn);
      render();
    });
  }
}

function setupSelectAll() {
  for (const cb of document.querySelectorAll("[data-select-all]")) {
    cb.addEventListener("change", () => selectAll(cb.dataset.selectAll, cb.checked));
  }
}

el("clear-selection-btn").addEventListener("click", () => {
  state.selection[state.activeTab]?.clear();
  render();
});

async function pruneImages(dangling, untilHours) {
  const label = dangling ? "dangling images" : `images unused ${untilHours}h+`;
  showToast(`Pruning ${label}…`);
  try {
    const res = await fetch("/api/actions/prune-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dangling, until_hours: dangling ? null : untilHours }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast(`Prune requested: ${label}`);
  } catch (e) {
    showToast("Prune failed — see console");
    console.error(e);
  }
}

el("prune-dangling-btn").addEventListener("click", () => pruneImages(true, null));
el("prune-unused-btn").addEventListener("click", () => {
  const hours = parseInt(el("prune-unused-hours").value, 10) || 48;
  el("confirm-text").textContent =
    `Remove unused (tagged) images that have had no container for ${hours}+ hours, on every Portainer host? This cannot be undone.`;
  el("confirm-dialog").hidden = false;
  el("confirm-ok").onclick = () => {
    el("confirm-dialog").hidden = true;
    pruneImages(false, hours);
  };
  el("confirm-cancel").onclick = () => {
    el("confirm-dialog").hidden = true;
  };
});

el("refresh-btn").addEventListener("click", loadActionItems);

setupTabs();
setupSelectAll();
loadConfig();
loadActionItems();
setInterval(loadActionItems, REFRESH_MS);
