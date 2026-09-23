// Portainer Sidecar frontend.
//
// Reads the four HA tracking sensors (sensor.portainer_updates_pending,
// sensor.portainer_trouble, sensor.portainer_stale_devices,
// sensor.portainer_cleanup) via this app's own backend, which proxies HA's
// REST API, and renders four endpoint-grouped tree tabs. See main.py for
// the API this talks to.

const REFRESH_MS = 15000;

const state = {
  activeTab: "updates",
  data: {
    updates: { count: 0, items: [] },
    trouble: { count: 0, items: [] },
    stale: { count: 0, items: [] },
    cleanup: { count: 0, items: [] },
  },
  selection: { updates: new Set(), stale: new Set() },
  haBaseUrl: "",
  // Collapse state, default expanded. Endpoint-level keyed by the
  // endpoint's own device_id (or host name, if that's ever missing);
  // stack-level keyed by `${endpointKey}::${stackKey}` so the same stack
  // name under two different endpoints never collides.
  collapsedEndpoints: new Set(),
  collapsedStacks: new Set(),
};

const el = (id) => document.getElementById(id);

// Valid initial tab from the URL's #fragment, e.g. a stack-restart-needed
// phone notification links to "<actions_url>#trouble" so tapping it lands
// the webapp directly on that tab instead of wherever it happened to be
// left last time.
function tabFromHash() {
  const hash = (location.hash || "").replace(/^#/, "");
  return ["updates", "trouble", "stale", "cleanup"].includes(hash) ? hash : null;
}

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
  const updateIds = new Set((state.data.updates.items || []).map((i) => i.entity));
  for (const id of [...state.selection.updates]) {
    if (!updateIds.has(id)) state.selection.updates.delete(id);
  }
  const staleIds = new Set((state.data.stale.items || []).map((i) => staleDeviceId(i)).filter(Boolean));
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
  // (1.3.0) Cleanup's sensor state is a running SUM of the per-endpoint
  // unused-image estimate, not an item count -- see sensor.py's
  // PortainerCleanupCoordinator. Still the right number for the tab
  // badge: "how many unused images across every host," same idea as the
  // other three counts, just not len(items) under the hood.
  el("count-cleanup").textContent = state.data.cleanup.count;

  const totalCount =
    state.data.updates.count + state.data.trouble.count + state.data.stale.count + state.data.cleanup.count;
  el("empty-state").hidden = totalCount !== 0;
  for (const panel of document.querySelectorAll(".panel")) {
    panel.hidden = totalCount === 0 || panel.dataset.panel !== state.activeTab;
  }

  renderUpdatesRows();
  renderTroubleRows();
  renderStaleRows();
  renderCleanupRows();
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

// ---------------------------------------------------------------------
// Generic endpoint/stack tree grouping, shared by Updates/Trouble/Stale.
// Items carry host/host_device_id (endpoint) and, where applicable,
// stack_name/stack_device_id (or switch_entity_id for Trouble's
// stack_restart_needed items) -- see ha-portainer-dashboard's sensor.py
// for exactly which fields each sensor's items carry.
// ---------------------------------------------------------------------

function groupByEndpoint(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.host_device_id || item.host || "__unknown__";
    if (!groups.has(key)) {
      groups.set(key, { key, host: item.host || "Unknown host", items: [] });
    }
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((a, b) => a.host.localeCompare(b.host));
}

function groupByStack(items) {
  const stacks = new Map();
  const direct = [];
  for (const item of items) {
    if (item.stack_name) {
      const key = item.stack_device_id || item.stack_name;
      if (!stacks.has(key)) {
        stacks.set(key, {
          key,
          label: item.stack_name,
          switchEntityId: item.stack_switch_entity_id || item.switch_entity_id || null,
          items: [],
        });
      }
      stacks.get(key).items.push(item);
    } else {
      direct.push(item);
    }
  }
  const stackList = [...stacks.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { stacks: stackList, direct };
}

// A tree-header row (endpoint OR stack level) -- an expand/collapse
// toggle, an optional cascading select-all checkbox, an optional inline
// badge, and an optional action button (Reload Endpoint / Restart Stack
// Now) that lives on the header itself rather than a child row.
function renderGroupHeaderRow({
  label,
  count,
  indent,
  showCheckbox,
  checked,
  indeterminate,
  onToggleSelect,
  expanded,
  onToggleExpand,
  badgeHtml,
  actionButton, // { text, onClick } | null
}) {
  const tr = document.createElement("tr");
  tr.className = "stack-row";

  const tdCheck = document.createElement("td");
  if (showCheckbox) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.indeterminate = indeterminate;
    cb.title = "Select everything under this group";
    cb.addEventListener("change", () => onToggleSelect(cb.checked));
    tdCheck.appendChild(cb);
  }
  tr.appendChild(tdCheck);

  const tdName = document.createElement("td");
  tdName.colSpan = 2;
  const wrap = document.createElement("div");
  if (indent) wrap.className = "row-name-indent";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "stack-toggle";
  toggle.textContent = `${expanded ? "▾" : "▸"} ${label} (${count})`;
  toggle.addEventListener("click", onToggleExpand);
  wrap.appendChild(toggle);
  if (badgeHtml) {
    const badge = document.createElement("span");
    badge.className = "trouble-badge";
    badge.innerHTML = badgeHtml;
    wrap.appendChild(badge);
  }
  if (actionButton) {
    const btn = document.createElement("button");
    btn.className = "row-action-btn";
    btn.textContent = actionButton.text;
    btn.style.marginLeft = "12px";
    btn.style.float = "none";
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      actionButton.onClick(btn);
    });
    wrap.appendChild(btn);
  }
  tdName.appendChild(wrap);
  tr.appendChild(tdName);
  return tr;
}

// ---------------------------------------------------------------------
// Updates tab -- endpoint -> stack -> container. Unstacked containers
// omit the stack level entirely (sit directly under their endpoint)
// rather than a fake "Standalone" grouping node.
// ---------------------------------------------------------------------

const rowInstallButtons = new Map();

function renderUpdateChildRow(item, indentLevel) {
  const tr = document.createElement("tr");
  tr.className = "stack-child-row";
  if (state.selection.updates.has(item.entity)) tr.classList.add("selected");

  const tdCheck = document.createElement("td");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.selection.updates.has(item.entity);
  cb.addEventListener("change", () => toggleSelection("updates", item.entity, cb.checked));
  tdCheck.appendChild(cb);

  const tdName = document.createElement("td");
  const indentClass = indentLevel === 2 ? "row-name-indent-2" : indentLevel === 1 ? "row-name-indent" : "";
  tdName.innerHTML = `<div class="row-name ${indentClass}">${escapeHtml(item.name)}</div>`;

  const tdStatus = document.createElement("td");
  const installBtn = document.createElement("button");
  installBtn.className = "row-action-btn";
  installBtn.textContent = "Install";
  installBtn.addEventListener("click", () => {
    const restore = withBusy(installBtn, "Installing…");
    installUpdates([item.entity]).finally(restore);
  });
  rowInstallButtons.set(item.entity, installBtn);
  tdStatus.innerHTML = `<span class="row-secondary">Update available</span>`;
  tdStatus.appendChild(installBtn);
  if (item.changelog_url) {
    const changelogLink = document.createElement("a");
    changelogLink.className = "row-changelog-link";
    changelogLink.href = item.changelog_url;
    changelogLink.target = "_blank";
    changelogLink.rel = "noopener";
    changelogLink.textContent = "Changelog";
    tdStatus.appendChild(changelogLink);
  }

  tr.append(tdCheck, tdName, tdStatus);
  return tr;
}

function renderUpdatesRows() {
  const tbody = el("rows-updates");
  tbody.innerHTML = "";
  rowInstallButtons.clear();
  const items = state.data.updates.items || [];
  if (items.length === 0) {
    tbody.appendChild(emptyRow(3, "No pending updates."));
    return;
  }

  const endpointGroups = groupByEndpoint(items);
  const singleEndpoint = endpointGroups.length === 1;

  for (const ep of endpointGroups) {
    const epEntities = ep.items.map((i) => i.entity);
    const epExpanded = !state.collapsedEndpoints.has(`updates::${ep.key}`);

    if (!singleEndpoint) {
      tbody.appendChild(
        renderGroupHeaderRow({
          label: ep.host,
          count: ep.items.length,
          indent: false,
          showCheckbox: true,
          checked: epEntities.every((id) => state.selection.updates.has(id)),
          indeterminate:
            epEntities.some((id) => state.selection.updates.has(id)) &&
            !epEntities.every((id) => state.selection.updates.has(id)),
          onToggleSelect: (checked) => {
            for (const id of epEntities) {
              if (checked) state.selection.updates.add(id);
              else state.selection.updates.delete(id);
            }
            render();
          },
          expanded: epExpanded,
          onToggleExpand: () => {
            if (epExpanded) state.collapsedEndpoints.add(`updates::${ep.key}`);
            else state.collapsedEndpoints.delete(`updates::${ep.key}`);
            render();
          },
        })
      );
      if (!epExpanded) continue;
    }

    const { stacks, direct } = groupByStack(ep.items);
    const childIndent = singleEndpoint ? 1 : 2;

    for (const stack of stacks) {
      const stackKey = `updates::${ep.key}::${stack.key}`;
      const stackEntities = stack.items.map((i) => i.entity);
      const stackExpanded = !state.collapsedStacks.has(stackKey);
      const hasOpenTrouble = stack.items.some((i) => i.stack_has_open_trouble);

      tbody.appendChild(
        renderGroupHeaderRow({
          label: stack.label,
          count: stack.items.length,
          indent: !singleEndpoint,
          showCheckbox: true,
          checked: stackEntities.every((id) => state.selection.updates.has(id)),
          indeterminate:
            stackEntities.some((id) => state.selection.updates.has(id)) &&
            !stackEntities.every((id) => state.selection.updates.has(id)),
          onToggleSelect: (checked) => {
            for (const id of stackEntities) {
              if (checked) state.selection.updates.add(id);
              else state.selection.updates.delete(id);
            }
            render();
          },
          expanded: stackExpanded,
          onToggleExpand: () => {
            if (stackExpanded) state.collapsedStacks.add(stackKey);
            else state.collapsedStacks.delete(stackKey);
            render();
          },
          badgeHtml: hasOpenTrouble ? "⚠ Needs remediation — see Trouble" : null,
        })
      );
      if (!stackExpanded) continue;
      for (const item of stack.items) tbody.appendChild(renderUpdateChildRow(item, childIndent));
    }

    for (const item of direct) {
      tbody.appendChild(renderUpdateChildRow(item, singleEndpoint ? 0 : 1));
    }
  }
}

// ---------------------------------------------------------------------
// Trouble tab -- endpoint -> (stack -> stuck container) | unstacked
// container | the endpoint's own row when IT is the trouble. See
// ha-portainer-dashboard's sensor.py PortainerTroubleCoordinator for the
// "kind" values this renders.
// ---------------------------------------------------------------------

function troubleViewLink(item) {
  if (!state.haBaseUrl || !item.entity) return null;
  const link = document.createElement("a");
  link.href = `${state.haBaseUrl}/history?entity_id=${encodeURIComponent(item.entity)}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.className = "row-action-btn";
  link.style.textDecoration = "none";
  link.textContent = "View";
  return link;
}

function renderTroubleChildRow(item, indentLevel) {
  const tr = document.createElement("tr");
  const tdName = document.createElement("td");
  const indentClass = indentLevel === 2 ? "row-name-indent-2" : indentLevel === 1 ? "row-name-indent" : "";
  tdName.innerHTML = `<div class="row-name ${indentClass}">${escapeHtml(item.name)}</div>`;
  const tdStatus = document.createElement("td");
  tdStatus.innerHTML = `<span class="row-secondary">${escapeHtml(item.secondary_info || "")}</span>`;

  if (item.kind === "unstacked_recreate") {
    const btn = document.createElement("button");
    btn.className = "row-action-btn";
    btn.textContent = "More Info";
    btn.addEventListener("click", () => showInfoDialog(item.name, item.detail || item.secondary_info || ""));
    tdStatus.appendChild(btn);
  } else {
    const link = troubleViewLink(item);
    if (link) tdStatus.appendChild(link);
  }

  tr.append(tdName, tdStatus);
  return tr;
}

function renderTroubleRows() {
  const tbody = el("rows-trouble");
  tbody.innerHTML = "";
  const items = state.data.trouble.items || [];
  if (items.length === 0) {
    tbody.appendChild(emptyRow(2, "Nothing in trouble."));
    return;
  }

  const endpointItems = items.filter((i) => i.kind === "endpoint");
  const otherItems = items.filter((i) => i.kind !== "endpoint");
  const endpointGroups = groupByEndpoint(otherItems);
  // An endpoint that's itself the trouble might have no OTHER items under
  // it at all -- still needs its own row, so it isn't just silently
  // dropped from the tree.
  for (const epItem of endpointItems) {
    if (!endpointGroups.some((g) => g.key === (epItem.host_device_id || epItem.host))) {
      endpointGroups.push({ key: epItem.host_device_id || epItem.host, host: epItem.host, items: [] });
    }
  }
  endpointGroups.sort((a, b) => a.host.localeCompare(b.host));

  const singleEndpoint = endpointGroups.length === 1 && endpointItems.length === 0;

  for (const ep of endpointGroups) {
    const epItem = endpointItems.find((i) => (i.host_device_id || i.host) === ep.key);

    if (epItem) {
      // The endpoint itself carries the trouble state -- its own row IS
      // the item, with the Reload Endpoint action directly on it, rather
      // than a header row plus a redundant child row saying the same
      // thing.
      tbody.appendChild(
        renderGroupHeaderRow({
          label: `${ep.host} — unreachable`,
          count: ep.items.length,
          indent: false,
          showCheckbox: false,
          expanded: !state.collapsedEndpoints.has(`trouble::${ep.key}`),
          onToggleExpand: () => {
            const key = `trouble::${ep.key}`;
            if (state.collapsedEndpoints.has(key)) state.collapsedEndpoints.delete(key);
            else state.collapsedEndpoints.add(key);
            render();
          },
          actionButton: {
            text: "Reload Endpoint",
            onClick: (btn) => {
              const restore = withBusy(btn, "Reloading…");
              reloadEndpoint(ep.key).finally(restore);
            },
          },
        })
      );
      if (state.collapsedEndpoints.has(`trouble::${ep.key}`)) continue;
    } else if (!singleEndpoint) {
      const epExpanded = !state.collapsedEndpoints.has(`trouble::${ep.key}`);
      tbody.appendChild(
        renderGroupHeaderRow({
          label: ep.host,
          count: ep.items.length,
          indent: false,
          showCheckbox: false,
          expanded: epExpanded,
          onToggleExpand: () => {
            if (epExpanded) state.collapsedEndpoints.add(`trouble::${ep.key}`);
            else state.collapsedEndpoints.delete(`trouble::${ep.key}`);
            render();
          },
        })
      );
      if (!epExpanded) continue;
    }

    const { stacks, direct } = groupByStack(ep.items);
    const childIndent = singleEndpoint ? 1 : 2;

    for (const stack of stacks) {
      const stackKey = `trouble::${ep.key}::${stack.key}`;
      const stackExpanded = !state.collapsedStacks.has(stackKey);
      tbody.appendChild(
        renderGroupHeaderRow({
          label: stack.label,
          count: stack.items.length,
          indent: !singleEndpoint,
          showCheckbox: false,
          expanded: stackExpanded,
          onToggleExpand: () => {
            if (stackExpanded) state.collapsedStacks.add(stackKey);
            else state.collapsedStacks.delete(stackKey);
            render();
          },
          actionButton: stack.switchEntityId
            ? {
                text: "Restart Stack Now",
                onClick: (btn) => {
                  const restore = withBusy(btn, "Restarting…");
                  restartStack(stack.switchEntityId).finally(restore);
                },
              }
            : null,
        })
      );
      if (!stackExpanded) continue;
      for (const item of stack.items) tbody.appendChild(renderTroubleChildRow(item, childIndent));
    }
    for (const item of direct) {
      tbody.appendChild(renderTroubleChildRow(item, singleEndpoint ? 0 : 1));
    }
  }
}

// ---------------------------------------------------------------------
// Stale tab -- endpoint -> device.
// ---------------------------------------------------------------------

function renderStaleRows() {
  const tbody = el("rows-stale");
  tbody.innerHTML = "";
  const items = state.data.stale.items || [];
  if (items.length === 0) {
    tbody.appendChild(emptyRow(3, "No stale devices."));
    return;
  }

  const endpointGroups = groupByEndpoint(items);
  const singleEndpoint = endpointGroups.length === 1;

  for (const ep of endpointGroups) {
    const epIds = ep.items.map((i) => staleDeviceId(i)).filter(Boolean);
    if (!singleEndpoint) {
      const epExpanded = !state.collapsedEndpoints.has(`stale::${ep.key}`);
      tbody.appendChild(
        renderGroupHeaderRow({
          label: ep.host,
          count: ep.items.length,
          indent: false,
          showCheckbox: true,
          checked: epIds.every((id) => state.selection.stale.has(id)),
          indeterminate:
            epIds.some((id) => state.selection.stale.has(id)) && !epIds.every((id) => state.selection.stale.has(id)),
          onToggleSelect: (checked) => {
            for (const id of epIds) {
              if (checked) state.selection.stale.add(id);
              else state.selection.stale.delete(id);
            }
            render();
          },
          expanded: epExpanded,
          onToggleExpand: () => {
            if (epExpanded) state.collapsedEndpoints.add(`stale::${ep.key}`);
            else state.collapsedEndpoints.delete(`stale::${ep.key}`);
            render();
          },
        })
      );
      if (!epExpanded) continue;
    }

    for (const item of ep.items) {
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
      const indentClass = singleEndpoint ? "" : "row-name-indent";
      tdName.innerHTML = `<div class="row-name ${indentClass}">${escapeHtml(item.name)}</div>`;

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
}

// ---------------------------------------------------------------------
// Cleanup tab (1.3.0, new) -- endpoint -> three fixed, ordered actions:
// Clean dangling images -> Reclaim all images -> Prune unused volumes.
// No checkboxes/batch model: each row's button acts immediately on that
// one endpoint. Ordering itself implies the intended workflow (do the
// safe thing first); rows never disappear or reorder based on state.
// ---------------------------------------------------------------------

function mibToCompactGb(mib) {
  if (mib === null || mib === undefined) return null;
  const gb = mib / 1024;
  if (gb < 0.05) return "<0.1 GB";
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

function renderCleanupActionRow({ label, note, badgeText, buttonText, indent, onClick }) {
  const tr = document.createElement("tr");
  const tdName = document.createElement("td");
  const indentClass = indent ? "row-name-indent" : "";
  let html = `<div class="row-name ${indentClass}">${escapeHtml(label)}`;
  if (badgeText) html += `<span class="cleanup-info-badge">${escapeHtml(badgeText)}</span>`;
  html += `</div>`;
  if (note) html += `<div class="cleanup-note ${indentClass}">${escapeHtml(note)}</div>`;
  tdName.innerHTML = html;

  const tdAction = document.createElement("td");
  const btn = document.createElement("button");
  btn.className = "row-action-btn";
  btn.textContent = buttonText;
  btn.addEventListener("click", () => onClick(btn));
  tdAction.appendChild(btn);

  tr.append(tdName, tdAction);
  return tr;
}

function renderCleanupRows() {
  const tbody = el("rows-cleanup");
  tbody.innerHTML = "";
  const items = state.data.cleanup.items || [];
  if (items.length === 0) {
    tbody.appendChild(emptyRow(2, "No endpoints found."));
    return;
  }

  const sorted = [...items].sort((a, b) => (a.host || "").localeCompare(b.host || ""));
  const singleEndpoint = sorted.length === 1;

  for (const ep of sorted) {
    const epKey = ep.device_id || ep.host;
    if (!singleEndpoint) {
      const epExpanded = !state.collapsedEndpoints.has(`cleanup::${epKey}`);
      tbody.appendChild(
        renderGroupHeaderRow({
          label: ep.host,
          count: 3,
          indent: false,
          showCheckbox: false,
          expanded: epExpanded,
          onToggleExpand: () => {
            if (epExpanded) state.collapsedEndpoints.add(`cleanup::${epKey}`);
            else state.collapsedEndpoints.delete(`cleanup::${epKey}`);
            render();
          },
        })
      );
      if (!epExpanded) continue;
    }

    const indent = !singleEndpoint;
    const unusedBadge = ep.unused_estimate === null || ep.unused_estimate === undefined ? null : `~${ep.unused_estimate} unused`;
    const reclaimBadge = mibToCompactGb(ep.reclaimable_mib);

    // 1. Clean dangling images -- always safe, no confirmation.
    tbody.appendChild(
      renderCleanupActionRow({
        label: "Clean dangling images",
        note: "Untagged orphan layers only — never referenced by any container, running or stopped.",
        badgeText: unusedBadge,
        buttonText: "Clean",
        indent,
        onClick: (btn) => {
          const restore = withBusy(btn, "Cleaning…");
          pruneImages(true, null, [ep.device_id]).finally(restore);
        },
      })
    );

    // 2. Reclaim all images -- no age buffer, confirm dialog.
    tbody.appendChild(
      renderCleanupActionRow({
        label: "Reclaim all images",
        note: "Removes every tagged image with no referencing container, immediately. A container started again afterward just re-pulls its image.",
        badgeText: reclaimBadge,
        buttonText: "Reclaim",
        indent,
        onClick: (btn) => {
          showConfirmDialog(
            `Remove every unused image on ${ep.host}? This cannot be undone — a container started again afterward will need to re-pull its image.`,
            "Reclaim",
            () => {
              const restore = withBusy(btn, "Reclaiming…");
              pruneImages(false, null, [ep.device_id]).finally(restore);
            }
          );
        },
      })
    );

    // 3. Prune unused volumes -- courtesy action, confirm dialog.
    tbody.appendChild(
      renderCleanupActionRow({
        label: "Prune unused volumes",
        note: "Same action as Portainer's own “Prune unused volumes” button — core's Portainer integration gives limited visibility into what's actually unused.",
        badgeText: null,
        buttonText: "Prune",
        indent,
        onClick: (btn) => {
          showConfirmDialog(
            `Remove every unused Docker volume on ${ep.host}? This cannot be undone.`,
            "Prune",
            () => {
              const restore = withBusy(btn, "Pruning…");
              pruneVolumes([ep.device_id]).finally(restore);
            }
          );
        },
      })
    );
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
  if (category === "trouble" || category === "cleanup") {
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
    else {
      const ids = [...sel];
      const restoreBar = withBusy(btn, `Installing ${ids.length} update(s)…`);
      const restoreRows = ids
        .map((id) => rowInstallButtons.get(id))
        .filter(Boolean)
        .map((rowBtn) => withBusy(rowBtn, "Installing…"));
      installUpdates(ids).finally(() => {
        restoreBar();
        for (const restore of restoreRows) restore();
      });
    }
  };
}

function selectAll(category, checked) {
  const items = state.data[category].items || [];
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
    } else if (result.needs_stack_restart && result.needs_stack_restart.length > 0) {
      // (1.3.0) No persistent banner -- a one-time toast pointing at the
      // Trouble tab, which is where the actual remediation now lives (see
      // renderTroubleRows above). Trouble picks this up on its own next
      // poll without anything special needed here.
      showToast(`Installed ${entityIds.length} update(s) — a stack needs a restart, see the Trouble tab`);
    } else {
      showToast(`Installed ${entityIds.length} update(s)`);
    }
  } catch (e) {
    showToast("Install failed — see console");
    console.error(e);
  }
  loadActionItems();
}

async function restartStack(switchEntityId) {
  showToast("Restarting stack…");
  try {
    const res = await fetch("/api/actions/restart-stack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ switch_entity_id: switchEntityId }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).detail || "";
      } catch {
        // Response wasn't JSON -- fall through with just the status.
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    showToast("Stack restart requested");
  } catch (e) {
    showToast(`Restart failed — ${e.message}`);
    console.error(e);
  }
  loadActionItems();
}

async function reloadEndpoint(deviceId) {
  showToast("Reloading endpoint…");
  try {
    const res = await fetch("/api/actions/reload-endpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast("Endpoint reload requested");
  } catch (e) {
    showToast(`Reload failed — ${e.message}`);
    console.error(e);
  }
  loadActionItems();
}

function confirmDeleteSelected() {
  const ids = [...state.selection.stale];
  if (ids.length === 0) return;
  showConfirmDialog(
    `Permanently delete ${ids.length} stale device${ids.length === 1 ? "" : "s"}? This cannot be undone.`,
    "Delete",
    () => deleteStaleDevices(ids)
  );
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

async function pruneImages(dangling, untilHours, deviceIds) {
  const label = dangling ? "dangling images" : "unused images";
  showToast(`Pruning ${label}…`);
  try {
    const body = { dangling, until_hours: dangling ? null : untilHours };
    if (deviceIds && deviceIds.length) body.device_ids = deviceIds;
    const res = await fetch("/api/actions/prune-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast(`Prune requested: ${label}`);
  } catch (e) {
    showToast("Prune failed — see console");
    console.error(e);
  }
  loadActionItems();
}

async function pruneVolumes(deviceIds) {
  showToast("Pruning unused volumes…");
  try {
    const body = {};
    if (deviceIds && deviceIds.length) body.device_ids = deviceIds;
    const res = await fetch("/api/actions/prune-volumes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast("Volume prune requested");
  } catch (e) {
    showToast("Prune failed — see console");
    console.error(e);
  }
  loadActionItems();
}

let toastTimer = null;
// Every action button (row Install, batch Install, restart/reload/cleanup
// actions) gets an immediate visual acknowledgement on click -- disables
// the button and swaps its label to a busy state right away, rather than
// relying on a toast someone might not be looking at. The caller runs the
// returned restore function once the action settles (success OR failure);
// it's a no-op if the button's already gone from the DOM by then, which
// is exactly what happens on a successful install.
function withBusy(btn, busyText) {
  const originalText = btn.textContent;
  const originalDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = busyText;
  return () => {
    btn.disabled = originalDisabled;
    btn.textContent = originalText;
  };
}

function showToast(text) {
  const toast = el("toast");
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 4000);
}

function showConfirmDialog(text, confirmLabel, onConfirm) {
  el("confirm-text").textContent = text;
  el("confirm-ok").textContent = confirmLabel;
  el("confirm-dialog").hidden = false;
  el("confirm-ok").onclick = () => {
    el("confirm-dialog").hidden = true;
    onConfirm();
  };
  el("confirm-cancel").onclick = () => {
    el("confirm-dialog").hidden = true;
  };
}

function showInfoDialog(title, text) {
  el("info-title").textContent = title;
  el("info-text").textContent = text;
  el("info-dialog").hidden = false;
  el("info-close").onclick = () => {
    el("info-dialog").hidden = true;
  };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function activateTab(tabName) {
  state.activeTab = tabName;
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.tab === tabName);
  render();
}

function setupTabs() {
  for (const btn of document.querySelectorAll(".tab")) {
    btn.addEventListener("click", () => {
      location.hash = btn.dataset.tab;
      activateTab(btn.dataset.tab);
    });
  }
  window.addEventListener("hashchange", () => {
    const tab = tabFromHash();
    if (tab) activateTab(tab);
  });
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

el("refresh-btn").addEventListener("click", loadActionItems);

setupTabs();
setupSelectAll();

const initialTab = tabFromHash();
if (initialTab) activateTab(initialTab);

loadConfig();
loadActionItems();
setInterval(loadActionItems, REFRESH_MS);
