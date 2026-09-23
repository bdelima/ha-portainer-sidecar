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
  // (1.3.1) Which actions are currently in flight, by a stable key
  // ("install:<entity>", "restart-stack:<switchEntityId>", etc). Every
  // button below is rendered FROM this set on every render() pass, rather
  // than having its busy/disabled state poked onto a specific DOM node at
  // click time (the old approach). That distinction matters because
  // render() runs on every 15s poll regardless of what's in flight --
  // renderUpdatesRows() in particular rebuilds its whole <tbody> from
  // scratch every time, which silently discarded any one-off DOM mutation
  // the moment a poll landed mid-action. A stack-restart-needed install
  // can run for up to 150s (_await_recreate_outcome's own watch window),
  // comfortably longer than one 15s poll, so this wasn't a rare edge case
  // -- any install slow enough to span a poll would visibly "forget" it
  // was still running and look clickable again. Driving button state from
  // this set instead means every render(), however triggered, reflects
  // reality.
  pendingActions: new Set(),
  // (1.3.1) A failed "Restart Stack Now" gets a persistent inline error on
  // the Trouble tab's stack row, not just a toast -- this is the one action
  // in the whole app where a silent failure is actively misleading (tap it,
  // assume the stack recovered, walk away). Keyed by switch_entity_id;
  // cleared on the next successful restart of that stack, or dropped by
  // pruneStackRestartErrors() once that stack no longer shows a
  // stack_restart_needed item at all (resolved some other way -- manual
  // Portainer intervention, an endpoint reload, etc).
  stackRestartErrors: new Map(),
};

const el = (id) => document.getElementById(id);

// See state.pendingActions above for why this exists instead of mutating
// a button's disabled/text properties directly at click time.
function isPending(key) {
  return state.pendingActions.has(key);
}

// Marks one or more keys pending, runs fn, then clears them -- always,
// whether fn resolves or throws. Calls render() immediately on entry (so
// the busy state shows up right away, not just on the next poll) and
// again on exit. Most callers' fn already ends in loadActionItems(),
// which calls render() itself, but the render() here still matters: it's
// what makes the button look busy for the (possibly many seconds)
// between click and that first server round trip.
async function runPending(keys, fn) {
  const keyList = Array.isArray(keys) ? keys : [keys];
  for (const k of keyList) state.pendingActions.add(k);
  render();
  try {
    await fn();
  } finally {
    for (const k of keyList) state.pendingActions.delete(k);
    render();
  }
}

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
    pruneStackRestartErrors();
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

// Drop a persistent restart error once its stack no longer has an open
// stack_restart_needed item -- the underlying problem cleared some other
// way (manual Portainer intervention, an endpoint reload bringing things
// back cleanly, etc), so the stale error would otherwise sit there forever
// with nothing to retry.
function pruneStackRestartErrors() {
  if (state.stackRestartErrors.size === 0) return;
  const stillNeedsRestart = new Set(
    (state.data.trouble.items || [])
      .filter((i) => i.kind === "stack_restart_needed")
      .map((i) => i.stack_switch_entity_id || i.switch_entity_id)
      .filter(Boolean)
  );
  for (const switchEntityId of [...state.stackRestartErrors.keys()]) {
    if (!stillNeedsRestart.has(switchEntityId)) state.stackRestartErrors.delete(switchEntityId);
  }
}

function setTabCount(id, tabKey, count) {
  const span = el(id);
  span.textContent = count;
  const nonzero = count > 0;
  span.classList.toggle("nonzero", nonzero);
  // (1.3.2) Only ever one nonzero-<tab> class active at a time per
  // badge, but toggle() with a false condition still needs the exact
  // class name removed -- listing all four and only add-ing the current
  // tab's keeps a stale color from a previous render (e.g. a hot-reload
  // during dev) from lingering on the wrong badge.
  for (const key of ["updates", "trouble", "stale", "cleanup"]) {
    span.classList.toggle(`nonzero-${key}`, nonzero && key === tabKey);
  }
}

function render() {
  setTabCount("count-updates", "updates", state.data.updates.count);
  setTabCount("count-trouble", "trouble", state.data.trouble.count);
  setTabCount("count-stale", "stale", state.data.stale.count);
  // (1.3.0) Cleanup's sensor state is a running SUM of the per-endpoint
  // unused-image estimate, not an item count -- see sensor.py's
  // PortainerCleanupCoordinator. Still the right number for the tab
  // badge: "how many unused images across every host," same idea as the
  // other three counts, just not len(items) under the hood.
  setTabCount("count-cleanup", "cleanup", state.data.cleanup.count);

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

// (fix) How many distinct Portainer endpoints this household actually
// has, used to decide whether a tab's endpoint level is worth showing at
// all. Cleanup's own sensor is the one reliable source for this: it
// carries exactly one item per discovered endpoint, unconditionally,
// whether or not that endpoint currently has anything to clean up (see
// PortainerCleanupCoordinator server-side). Updates/Trouble/Stale's own
// item lists only include an endpoint when it currently has something to
// report, so using THEIR list length to decide "is this a single-endpoint
// household" conflates two different questions: "does this household
// only have one endpoint" (a real reason to collapse the level, since
// naming a host that's always the only option is just noise) vs "does
// only one endpoint currently have something wrong" (the endpoint's name
// is exactly the context that matters there, especially with 3 real
// endpoints and only one of them in trouble at the moment). Answering the
// second question with the first one's logic is what hid which host was
// affected the moment only one endpoint had anything to show on Trouble.
function knownEndpointCount() {
  const count = (state.data.cleanup.items || []).length;
  return count > 0 ? count : 1;
}

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

// (1.3.2) Stacks that currently have an open stack_restart_needed
// Trouble item for the given endpoint, regardless of whether Updates
// still has any pending item for them. Used to keep a stack's row on the
// Updates tab visible -- with its warning badge but no children -- even
// after every one of its containers has been installed, rather than the
// stack (and the reminder that it still needs a manual restart) just
// vanishing the moment nothing's left to select. Sourced from Trouble's
// own item list rather than Updates', since once a stack's updates are
// all installed, Updates has nothing left carrying that stack's identity
// at all.
function stacksAwaitingRestart(troubleItems, endpointKey) {
  const map = new Map();
  for (const item of troubleItems) {
    if (item.kind !== "stack_restart_needed") continue;
    if ((item.host_device_id || item.host) !== endpointKey) continue;
    const key = item.stack_device_id || item.stack_name;
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: item.stack_name,
        switchEntityId: item.stack_switch_entity_id || item.switch_entity_id || null,
        items: [],
      });
    }
  }
  return [...map.values()];
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
  actionButton, // { text, pendingText, pending, onClick } | null
}) {
  const tr = document.createElement("tr");
  tr.className = "stack-row";

  // (fix) This cell used to be appended unconditionally, with only its
  // CONTENTS (the actual <input>) gated on showCheckbox. That's correct
  // for Updates/Stale, which really do have 3 real columns (checkbox,
  // name, status) -- but Trouble and Cleanup only declare 2 <th>s each
  // (no checkbox column exists in their markup at all), so they were
  // getting an empty phantom cell here PLUS tdName's own colspan=2 right
  // after it: 3 cells' worth of structure jammed into a 2-column table,
  // which is what visibly shoved every header row's label out of its
  // left-aligned position. showCheckbox now decides whether this cell
  // exists at all, not just whether it has an <input> in it -- every
  // current caller already passes showCheckbox in lockstep with whether
  // its target table actually has a checkbox column.
  if (showCheckbox) {
    const tdCheck = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.indeterminate = indeterminate;
    cb.title = "Select everything under this group";
    cb.addEventListener("change", () => onToggleSelect(cb.checked));
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);
  }

  const tdName = document.createElement("td");
  tdName.colSpan = 2;
  const wrap = document.createElement("div");
  if (indent) wrap.className = "row-name-indent";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "stack-toggle";
  // count === null is used for a phantom "still needs attention, nothing
  // left to select" stack row (see renderUpdatesRows) -- "(0)" there would
  // read as "nothing wrong" right next to a badge saying otherwise.
  toggle.textContent = `${expanded ? "▾" : "▸"} ${label}` + (count === null ? "" : ` (${count})`);
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
    btn.textContent = actionButton.pending ? actionButton.pendingText || actionButton.text : actionButton.text;
    btn.disabled = !!actionButton.pending;
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
  const installKey = `install:${item.entity}`;
  const installPending = isPending(installKey);
  const installBtn = document.createElement("button");
  installBtn.className = "row-action-btn";
  installBtn.textContent = installPending ? "Installing…" : "Install";
  installBtn.disabled = installPending;
  installBtn.addEventListener("click", () => {
    runPending(installKey, () => installUpdates([item.entity]));
  });
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
  const items = state.data.updates.items || [];
  const troubleItems = state.data.trouble.items || [];

  // (1.3.2) Endpoints that have no pending updates left but still have a
  // stack awaiting a manual restart need a row here too -- otherwise the
  // household's only remaining "you still need to do something" signal for
  // that host would live exclusively on the Trouble tab, and the endpoint
  // would vanish from Updates entirely rather than staying visible with
  // its phantom, childless stack. Collect every endpoint key that has
  // either real update items or an awaiting-restart stack.
  const endpointKeysWithUpdates = new Set(items.map((i) => i.host_device_id || i.host || "__unknown__"));
  const endpointKeysAwaitingRestart = new Set(
    troubleItems.filter((i) => i.kind === "stack_restart_needed").map((i) => i.host_device_id || i.host)
  );
  const allEndpointKeys = new Set([...endpointKeysWithUpdates, ...endpointKeysAwaitingRestart]);

  if (allEndpointKeys.size === 0) {
    tbody.appendChild(emptyRow(3, "No pending updates."));
    return;
  }

  const endpointGroups = groupByEndpoint(items);
  // Add placeholder endpoint groups for hosts that have an awaiting-restart
  // stack but zero real update items of their own (all installed already).
  for (const key of endpointKeysAwaitingRestart) {
    if (!endpointGroups.some((g) => g.key === key)) {
      const sample = troubleItems.find(
        (i) => i.kind === "stack_restart_needed" && (i.host_device_id || i.host) === key
      );
      endpointGroups.push({ key, host: sample ? sample.host : "Unknown host", items: [] });
    }
  }
  endpointGroups.sort((a, b) => a.host.localeCompare(b.host));
  const singleEndpoint = knownEndpointCount() <= 1;

  for (const ep of endpointGroups) {
    const epEntities = ep.items.map((i) => i.entity);
    const epExpanded = !state.collapsedEndpoints.has(`updates::${ep.key}`);
    const phantomStacks = stacksAwaitingRestart(troubleItems, ep.key);

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

    // (1.3.2) Merge in stacks that have no pending update items left but
    // still have an open restart-needed Trouble entry -- these render as a
    // childless row with a permanent badge rather than disappearing the
    // moment their last update is installed. A stack that still has real
    // update items handles its own badge via stack_has_open_trouble below,
    // so it's excluded here to avoid a duplicate row.
    const realStackKeys = new Set(stacks.map((s) => s.key));
    const phantomOnly = phantomStacks.filter((s) => !realStackKeys.has(s.key));
    const allStacks = [...stacks.map((s) => ({ ...s, phantom: false })), ...phantomOnly.map((s) => ({ ...s, phantom: true }))];
    allStacks.sort((a, b) => a.label.localeCompare(b.label));

    for (const stack of allStacks) {
      const stackKey = `updates::${ep.key}::${stack.key}`;
      const stackEntities = stack.items.map((i) => i.entity);
      const stackExpanded = !state.collapsedStacks.has(stackKey);
      const hasOpenTrouble = stack.phantom || stack.items.some((i) => i.stack_has_open_trouble);

      tbody.appendChild(
        renderGroupHeaderRow({
          label: stack.label,
          // A phantom stack has nothing left to count -- "(0)" next to a
          // "needs remediation" badge would read as "nothing's wrong here"
          // right beside a warning saying otherwise, so it's omitted.
          count: stack.phantom ? null : stack.items.length,
          indent: !singleEndpoint,
          showCheckbox: !stack.phantom,
          checked: !stack.phantom && stackEntities.every((id) => state.selection.updates.has(id)),
          indeterminate:
            !stack.phantom &&
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
      if (!stackExpanded || stack.phantom) continue;
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

// (1.3.1) Persistent inline error under a stack's header row after a
// failed "Restart Stack Now" -- shown regardless of the stack's own
// expand/collapse state, since this is the one failure in the app that
// genuinely needs to stay visible rather than auto-dismiss like a toast.
// Cleared by pruneStackRestartErrors() once the stack no longer needs a
// restart, or immediately on the next restart attempt (see restartStack).
function renderStackRestartErrorRow(message, indent) {
  const tr = document.createElement("tr");
  tr.className = "stack-restart-error-row";
  const td = document.createElement("td");
  td.colSpan = 2;
  const indentClass = indent ? "row-name-indent" : "";
  td.innerHTML = `<div class="stack-restart-error ${indentClass}">Restart failed: ${escapeHtml(message)}</div>`;
  tr.appendChild(td);
  return tr;
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

  // The endpointItems.length === 0 carve-out stays regardless of
  // knownEndpointCount(): when the trouble IS an endpoint being
  // unreachable, its row already reads "{host} — unreachable", so
  // collapsing the endpoint level there would delete the one piece of
  // information ("unreachable") the row exists to show.
  const singleEndpoint = knownEndpointCount() <= 1 && endpointItems.length === 0;

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
            pendingText: "Reloading…",
            pending: isPending(`reload-endpoint:${ep.key}`),
            onClick: () => runPending(`reload-endpoint:${ep.key}`, () => reloadEndpoint(ep.key)),
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
                pendingText: "Restarting…",
                pending: isPending(`restart-stack:${stack.switchEntityId}`),
                onClick: () =>
                  runPending(`restart-stack:${stack.switchEntityId}`, () => restartStack(stack.switchEntityId)),
              }
            : null,
        })
      );
      const restartError = stack.switchEntityId && state.stackRestartErrors.get(stack.switchEntityId);
      if (restartError) tbody.appendChild(renderStackRestartErrorRow(restartError, !singleEndpoint));
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
  const singleEndpoint = knownEndpointCount() <= 1;

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
// Cleanup tab (1.3.0, new) -- endpoint -> fixed, ordered actions: Prune
// images -> Prune unused volumes. (1.3.3: was three actions -- Clean
// dangling images / Reclaim all images / Prune unused volumes -- until the
// first two turned out to be the same operation in practice; see the
// (1.3.3) comment in renderCleanupRows for why.) No checkboxes/batch model:
// each row's button acts immediately on that one endpoint.
// ---------------------------------------------------------------------

function renderCleanupActionRow({ label, note, badgeText, buttonText, pendingText, pending, indent, onClick }) {
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
  btn.textContent = pending ? pendingText || buttonText : buttonText;
  btn.disabled = !!pending;
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
          // (fix) This used to be a hardcoded 3 -- the number of action
          // rows under every endpoint, which is always 3 regardless of
          // how much there actually is to clean up. That looked exactly
          // like the "how many things need attention" count every other
          // tab's header shows, but meant nothing -- every endpoint read
          // "(3)" no matter what. The real per-endpoint figure is the
          // same unused-image estimate the "Clean dangling images" row's
          // own badge already shows; null (unknown/unavailable upstream)
          // falls back to 0 rather than leaving the header blank.
          count: ep.unused_estimate ?? 0,
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
    // (1.3.3) There used to be two separate image actions here -- "Clean
    // dangling images" (dangling=true) and "Reclaim all images"
    // (dangling=false, meant to also remove tagged-but-unused images). The
    // dangling-only button is now hidden: core's `portainer.prune_images`
    // service calls pyportainer's images_prune(), which builds its request
    // as bare `?dangling=...`/`?until=...` query params instead of Docker's
    // actual required shape -- a JSON `filters` query param (confirmed
    // against Docker Engine's own API spec, moby/moby's api/swagger.yaml,
    // ImagePrune operation). Docker's daemon never sees a real dangling
    // filter either way, so it always falls back to its own default prune
    // scope -- dangling-only -- no matter which value HA sends. That made
    // the two buttons functionally identical: keeping both, one of them
    // silently not doing what its label promised, was worse than keeping
    // one and being honest about its current scope.
    //
    // Deliberately still wired as dangling=false (the original "Reclaim"
    // call), NOT switched to dangling=true -- this is the one line that
    // will start actually reclaiming every unused image, not just dangling
    // ones, the moment pyportainer's images_prune() is fixed upstream (see
    // the pyportainer-images-prune-bug-report.md handed to Bob -- no fix or
    // report existed yet as of this writing). Leaving the real wiring in
    // place means that fix requires zero changes on our side to take
    // effect; only the button's copy needs to catch up today.
    //
    // No badge here: unused_estimate (images beyond what's running) and
    // reclaimable_mib (byte-accurate, but across ALL unused images) both
    // describe a broader scope than this action can actually reach right
    // now, so showing either next to this specific button would repeat the
    // exact "pretending we know a number we don't" problem already fixed
    // once on this tab. unused_estimate still surfaces at the endpoint
    // header above, as a household-wide "how much is piling up" figure, not
    // a promise about what pressing this button will remove.
    const pruneKey = `cleanup-prune-images:${ep.device_id}`;
    tbody.appendChild(
      renderCleanupActionRow({
        label: "Prune images",
        note: "Removes dangling (untagged, unreferenced) images only. Note that image counts not resetting to 0 is indicative of current API limitations that restrict pruning all unused images. Further pruning would require direct action using the endpoint's Portainer UI.",
        badgeText: null,
        buttonText: "Prune",
        pendingText: "Pruning…",
        pending: isPending(pruneKey),
        indent,
        onClick: () => {
          showConfirmDialog(
            `Remove every unused image on ${ep.host}? This cannot be undone — a container started again afterward will need to re-pull its image.`,
            "Prune",
            () => runPending(pruneKey, () => pruneImages(false, null, [ep.device_id]))
          );
        },
      })
    );

    // 2. Prune unused volumes -- courtesy action, confirm dialog.
    const volumesKey = `cleanup-volumes:${ep.device_id}`;
    tbody.appendChild(
      renderCleanupActionRow({
        label: "Prune unused volumes",
        note: "Same action as Portainer's own “Prune unused volumes” button — core's Portainer integration gives limited visibility into what's actually unused.",
        badgeText: null,
        buttonText: "Prune",
        pendingText: "Pruning…",
        pending: isPending(volumesKey),
        indent,
        onClick: () => {
          showConfirmDialog(
            `Remove every unused Docker volume on ${ep.host}? This cannot be undone.`,
            "Prune",
            () => runPending(volumesKey, () => pruneVolumes([ep.device_id]))
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
  const batchKey = category === "stale" ? "delete-stale-batch" : "install-batch";
  const pending = isPending(batchKey);
  const btn = el("action-btn");
  btn.className = category === "stale" ? "primary-btn danger" : "primary-btn";
  btn.disabled = pending;
  btn.textContent = pending
    ? category === "stale"
      ? `Deleting ${sel.size} device(s)…`
      : `Installing ${sel.size} update(s)…`
    : category === "stale"
      ? `Delete ${sel.size} device(s)`
      : `Install ${sel.size} update(s)`;
  btn.onclick = () => {
    if (category === "stale") confirmDeleteSelected();
    else {
      const ids = [...sel];
      runPending([batchKey, ...ids.map((id) => `install:${id}`)], () => installUpdates(ids));
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
  // A retry attempt clears any previous error immediately, whether or not
  // this attempt itself succeeds -- the row shouldn't show a stale error
  // for an action that's actively in flight again.
  state.stackRestartErrors.delete(switchEntityId);
  render();
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
    // Toast alone isn't enough here -- it auto-dismisses, and someone
    // acting on a phone notification may not even be looking at the
    // webapp when this fires. A failed stack restart needs a persistent,
    // unmissable signal, not just a message that disappears in 4 seconds.
    showToast(`Restart failed — ${e.message}`);
    state.stackRestartErrors.set(switchEntityId, e.message);
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
    () => runPending("delete-stale-batch", () => deleteStaleDevices(ids))
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
