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
  // cleanup holds "<device_id>|<action>" for each ticked row on the Cleanup
  // tab (action: dangling | unused | volumes).
  selection: { updates: new Set(), stale: new Set(), cleanup: new Set() },
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

// (1.3.7) Every "open in a new tab" link in this app (changelog, history,
// device page) is a plain <a target="_blank" rel="noopener">, which works
// fine in a real browser but can silently do nothing when this app is
// rendered inside Home Assistant's iOS/Android companion app -- their
// embedded webview commonly disallows window.open()-style popup creation
// entirely unless the host app explicitly wires up a delegate for it,
// which is exactly what a target="_blank" anchor click triggers under the
// hood. Reported specifically for the changelog link (an external
// github.com/hub.docker.com URL); all three "new tab" links share the
// same underlying element, so all three are wired through here.
//
// (1.3.6, reverted) The first attempt at this fell back to
// `window.location.href = anchor.href` when window.open() came back
// falsy, on the theory that the companion apps intercept a top-level
// navigation attempt and hand it to the system browser. That was wrong,
// and actively harmful: this app is itself served inside an iframe (the
// integration's own sidebar panel), so `window` here is the IFRAME's
// window, not the tab/webview's top-level one -- the fallback navigated
// the panel's own iframe to github.com, and github.com correctly refuses
// to be framed by anything (X-Frame-Options/CSP), so the panel just broke
// with a "refused to connect" page in place of the dashboard, in both a
// real browser and the companion app. There's no reliable way from inside
// a nested, sandboxed webview to tell "navigate this window" apart from
// "break the view the user is looking at", so this no longer gambles on
// it. window.open() still gets tried -- it's a real new-tab/new-window
// request, not a same-frame navigation, so it can never clobber this
// app's own view even when it fails.
//
// (1.3.7, superseded) When window.open() was blocked, this tried
// navigator.clipboard.writeText() and showed a toast either way. In the
// companion app that API itself turned out to be unavailable (most likely
// because a webview doesn't expose Clipboard-write permissions to
// embedded iframe content, or the panel isn't served over a secure
// context there) -- so the fallback's own fallback fired, dumping the raw
// URL into a toast that auto-dismisses after 4 seconds with no way to
// actually select or copy it. Confirmed, not a guess: reported directly
// after 1.3.7 shipped.
//
// (1.3.8) Never assume the Clipboard API is there -- still try it as a
// convenience (showLinkDialog's Copy button), but the real fallback is a
// dialog with the URL in a plain readonly <input>. That can always be
// selected and copied by hand (long-press -> Copy on mobile, click-drag +
// Ctrl/Cmd-C on desktop), because that's native text selection, not the
// Clipboard API -- it works even where navigator.clipboard doesn't, and
// it doesn't disappear after 4 seconds.
// (fix) window.open()'s third argument used to be the literal string
// "noopener" -- a WINDOW FEATURES string, not a rel token. Passing ANY
// non-empty features string (even this one) is what tells some browsers
// and mobile WebViews "this is a popup window, not a plain new tab," which
// routes it through stricter blocking than a bare `_blank` target does.
// The anchors themselves already carry rel="noopener" for native
// navigation, so there's nothing this call needs the features string for
// -- dropped it, and null out .opener directly on the returned window
// instead for the cases where this function opens one itself.
//
// (fix) A user who isn't sure the first tap registered (no visible
// feedback while a new tab opens in the background) tends to tap again.
// If the first tap's popup succeeded, Chrome's "only one program-opened
// popup per gesture" heuristic can then block the SECOND tap's
// window.open() and report it as failed -- which used to pop the "couldn't
// open automatically" dialog even though the link had, in fact, already
// opened a moment earlier. EXTERNAL_OPEN_DEBOUNCE_MS makes a second
// invocation for the same URL within a short window a no-op instead of a
// second real attempt.
const EXTERNAL_OPEN_DEBOUNCE_MS = 1500;
let lastExternalOpen = { url: null, at: 0 };

function openExternal(url) {
  const now = Date.now();
  if (lastExternalOpen.url === url && now - lastExternalOpen.at < EXTERNAL_OPEN_DEBOUNCE_MS) return;
  lastExternalOpen = { url, at: now };
  const popup = window.open(url, "_blank");
  if (popup) popup.opener = null;
  else showLinkDialog(url);
}

// Assignment (.onclick =), not addEventListener -- this gets called on
// freshly-created row anchors (fine either way) but also on the
// changelog dialog's persistent "View on GitHub" button, which is
// re-wired every time a changelog opens rather than recreated. Assignment
// replaces the previous handler; addEventListener would silently stack a
// new one on every open, firing openExternal() multiple times per click
// after a few uses.
function wireExternalLink(anchor) {
  anchor.onclick = (event) => {
    event.preventDefault();
    openExternal(anchor.href);
  };
  return anchor;
}

// (fix) Every dialog on this page is an independent, always-in-the-DOM
// overlay that only toggles its own `hidden` -- nothing ever closed one
// dialog when another opened, so it was possible to end up with two
// stacked at once (e.g. a link inside the still-open changelog dialog
// falling back to the link-dialog): the top one showing, and the other
// sitting hidden-in-plain-sight underneath until the first was dismissed.
// Closing every OTHER dialog before showing a new one keeps this a strict
// one-at-a-time UI regardless of which combination of dialogs a given
// sequence of clicks happens to trigger.
const DIALOG_IDS = ["confirm-dialog", "info-dialog", "link-dialog", "changelog-dialog"];
function hideAllDialogs() {
  for (const id of DIALOG_IDS) el(id).hidden = true;
}

function showLinkDialog(url) {
  hideAllDialogs();
  const input = el("link-dialog-url");
  el("link-dialog-text").textContent =
    "This couldn't be opened automatically here. Copy the link below to open it yourself:";
  input.value = url;
  el("link-dialog").hidden = false;
  input.focus();
  input.select();
  el("link-dialog-copy").onclick = () => {
    navigator.clipboard
      ?.writeText(url)
      .then(() => showToast("Link copied to clipboard"))
      .catch(() => {
        input.focus();
        input.select();
      });
    if (!navigator.clipboard) {
      input.focus();
      input.select();
    }
  };
  el("link-dialog-close").onclick = () => {
    el("link-dialog").hidden = true;
  };
}

// ---------------------------------------------------------------------
// Changelog (1.3.8) -- renders a repo's latest GitHub release notes
// in-app instead of linking out to github.com. This is what finally
// closes the "changelog link doesn't work in the companion app" saga:
// nothing here opens a new window at all, so there's nothing for that
// webview to block. The backend (main.py's /api/changelog/{repo}) fetches
// and caches the release via GitHub's API; this just renders the result.
//
// renderMarkdownSafe is deliberately small, not a real CommonMark parser
// -- it covers what GitHub's own auto-generated release notes and most
// hand-written ones actually use (headings, bold/italic, inline code,
// bullet lists, markdown links, and bare URLs) and nothing more. Safety
// comes from ordering: the ENTIRE input is HTML-escaped first via
// escapeHtml, and every tag this function itself introduces afterward is
// one it built, with hrefs restricted to http(s) URLs. escapeHtml (below)
// escapes &/</> via a textContent round-trip but deliberately leaves `"`
// and `'` alone, since those aren't meaningful in HTML *text* content --
// which is exactly wrong for a value about to be spliced into an
// attribute. A release body containing a bare URL like
// `https://x/"onmouseover="alert(1)` would otherwise close the href
// attribute early and inject a live event-handler attribute onto the
// element -- confirmed, not a hypothetical, while reviewing this before
// it shipped. escapeAttr (below) additionally escapes quote characters
// for every href this function builds, so nothing extracted from the body
// can break out of the attribute it's placed in, however it's shaped.
// restoreEscapedEntities (below) runs after escapeHtml and before any of
// this function's own tag-building -- it only ever turns an
// already-escaped, allowlisted entity back into a real one (e.g.
// "&amp;nbsp;" -> "&nbsp;", a space once rendered), which is inert text,
// never new markup, so it doesn't reopen anything escapeHtml closed.
function escapeAttr(str) {
  return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// (fix) A release body can contain literal HTML character entities as
// plain text -- &nbsp; showed up in a real one (dozzle's) -- most likely
// pasted in from somewhere that used them for layout. escapeHtml above
// turns the leading & into &amp;, so without this step the browser shows
// the literal text "&nbsp;" instead of the space the author intended.
// This restores a small allowlist of named entities (plus any numeric
// reference, e.g. &#39; or &#x27; -- always safe, since a numeric
// reference can only ever decode to a single character and never
// introduces markup) back to real entities so the browser decodes them
// normally. Safe because it can only restore an entity that was ALREADY
// present as literal text in the untrusted source: "&amp;nbsp;" back to
// "&nbsp;" is a space once rendered, never a new tag or attribute -- an
// entity not on the allowlist (or not a valid entity at all) is left
// exactly as escapeHtml produced it.
// `quot` and `apos` are deliberately NOT on this list, and neither should
// ever be added -- found in review before this shipped: every href this
// file builds goes through escapeAttr(), which only matches a literal `"`/
// `'` CHARACTER, not the six-character text "&quot;"/"&apos;". A release
// body containing that literal text as part of a bare URL --
// `https://x/&quot;onmouseover=&quot;alert(1)` -- passes through
// escapeAttr() completely unescaped (there's no raw quote character for it
// to find), and once restored to `&quot;` here, the BROWSER's own
// attribute-value parser decodes it back into a real `"` while parsing
// `href="..."`, closing the attribute early and turning
// ` onmouseover=&quot;alert(1)` into a live event-handler attribute on the
// same tag -- confirmed against the actual code path, not a guess; this is
// the identical attribute-breakout class escapeAttr() exists to prevent,
// reached through entity syntax instead of a raw quote character.
// Everything below decodes to a character that cannot terminate a
// double-quoted attribute or re-enter the tokenizer as markup (decoded
// `<`/`>`/`&` are inert literal characters in whatever context -- text or
// attribute -- they land in, never new tag/attribute boundaries).
const RESTORABLE_HTML_ENTITIES = new Set([
  "nbsp", "amp", "lt", "gt", "cent", "pound", "yen", "euro",
  "copy", "reg", "trade", "deg", "plusmn", "times", "divide", "micro",
  "para", "middot", "laquo", "raquo", "iexcl", "iquest", "sect", "hellip",
  "mdash", "ndash", "lsquo", "rsquo", "ldquo", "rdquo", "bull", "dagger",
  "permil", "larr", "rarr", "uarr", "darr", "harr",
]);
function restoreEscapedEntities(text) {
  return text.replace(/&amp;(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{0,31});/g, (match, ent) => {
    if (ent[0] === "#") return `&${ent};`;
    return RESTORABLE_HTML_ENTITIES.has(ent.toLowerCase()) ? `&${ent};` : match;
  });
}

function inlineMarkdown(text) {
  let out = text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  // Bare URLs (common in GitHub's auto-generated notes -- "in
  // https://github.com/x/y/pull/123", not markdown [text](url) syntax) --
  // skipped when already inside an href="..." from the replace above.
  out = out.replace(/(?<!href=")(https?:\/\/[^\s<]+)/g, (match) => {
    const trimmed = match.replace(/[).,\]>"']+$/, "");
    const trailing = match.slice(trimmed.length);
    return `<a href="${escapeAttr(trimmed)}" target="_blank" rel="noopener">${trimmed}</a>${trailing}`;
  });
  return out;
}

function renderMarkdownSafe(markdown) {
  const escaped = restoreEscapedEntities(escapeHtml(markdown || ""));
  const lines = escaped.split("\n");
  const htmlLines = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      htmlLines.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (headerMatch) {
      closeList();
      const level = Math.min(headerMatch[1].length, 4) + 1; // h2..h5 -- h1 is the dialog title
      htmlLines.push(`<h${level}>${inlineMarkdown(headerMatch[2])}</h${level}>`);
    } else if (bulletMatch) {
      if (!inList) {
        htmlLines.push("<ul>");
        inList = true;
      }
      htmlLines.push(`<li>${inlineMarkdown(bulletMatch[1])}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      htmlLines.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  closeList();
  return htmlLines.join("\n");
}

async function showChangelogDialog(repo) {
  hideAllDialogs();
  el("changelog-dialog-title").textContent = repo;
  el("changelog-dialog-meta").textContent = "Loading…";
  el("changelog-dialog-body").innerHTML = "";
  el("changelog-dialog-view").hidden = true;
  el("changelog-dialog").hidden = false;
  el("changelog-dialog-close").onclick = () => {
    el("changelog-dialog").hidden = true;
  };

  let release;
  try {
    const res = await fetch(`/api/changelog/${encodeURIComponent(repo)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      el("changelog-dialog-meta").textContent = body.detail || `Couldn't load release notes (HTTP ${res.status}).`;
      return;
    }
    release = await res.json();
  } catch (e) {
    el("changelog-dialog-meta").textContent = "Couldn't load release notes — see console.";
    console.error(e);
    return;
  }

  const when = release.published_at ? new Date(release.published_at).toLocaleDateString() : null;
  el("changelog-dialog-title").textContent = `${repo} — ${release.name || release.tag_name || "latest release"}`;
  el("changelog-dialog-meta").textContent = [release.prerelease ? "Pre-release" : null, when].filter(Boolean).join(" · ");
  el("changelog-dialog-body").innerHTML =
    renderMarkdownSafe(release.body) || '<p class="muted">No description provided for this release.</p>';
  for (const a of el("changelog-dialog-body").querySelectorAll('a[target="_blank"]')) wireExternalLink(a);
  if (release.html_url) {
    const viewLink = el("changelog-dialog-view");
    viewLink.href = release.html_url;
    viewLink.hidden = false;
    wireExternalLink(viewLink);
  }
}

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
  // (1.3.12) '#needs-remediation' is the new deep-link hash used by the
  // dashboard integration's trouble notification (matching the Trouble
  // tab's display-only rename to 'Needs Remediation' in 1.3.11); the
  // internal tab id stays 'trouble' (see templates above), so this just
  // aliases the new hash onto the existing tab rather than renaming
  // anything else. '#trouble' keeps working for any older notification
  // already in a phone's tray or any other existing link.
  if (hash === "needs-remediation") return "trouble";
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
  const cleanupDevices = new Set((state.data.cleanup.items || []).map((ep) => ep.device_id).filter(Boolean));
  for (const id of [...state.selection.cleanup]) {
    if (!cleanupDevices.has(cleanupSelDevice(id))) state.selection.cleanup.delete(id);
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
  // for Updates/Stale/Cleanup, which really do have 3 real columns
  // (checkbox, name, status) -- but Trouble only declares 2 <th>s
  // (no checkbox column exists in its markup at all), so it was
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
  if (item.changelog_repo) {
    // (1.3.8) Renders release notes in-app (see showChangelogDialog) --
    // a plain in-page button, not a link, since nothing here opens a new
    // window at all. Needs a dashboard integration new enough to expose
    // changelog_repo; an older one (or a hand-curated override that isn't
    // a github.com URL) only has changelog_url, handled below instead.
    const changelogBtn = document.createElement("button");
    changelogBtn.type = "button";
    changelogBtn.className = "row-changelog-link row-changelog-btn";
    changelogBtn.textContent = "Changelog";
    changelogBtn.addEventListener("click", () => showChangelogDialog(item.changelog_repo));
    tdStatus.appendChild(changelogBtn);
  } else if (item.changelog_url) {
    const changelogLink = document.createElement("a");
    changelogLink.className = "row-changelog-link";
    changelogLink.href = item.changelog_url;
    changelogLink.target = "_blank";
    changelogLink.rel = "noopener";
    changelogLink.textContent = "Changelog";
    wireExternalLink(changelogLink);
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
          badgeHtml: hasOpenTrouble ? "⚠ See Needs Remediation tab" : null,
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

  // Most Trouble items can only be fixed on the host, so there is nothing
  // to open or run from here. Rows get only what applies:
  //   - More Info, when the integration sent a `detail` describing a manual
  //     remediation (unstacked_recreate, portainer_self_update);
  //   - Dismiss, when it sent a `dismiss_key` (an older integration doesn't,
  //     so those rows simply have no button).
  // Endpoint and stuck-stack items keep their actions on the group header.
  if (item.detail) {
    const info = document.createElement("button");
    info.className = "row-action-btn";
    info.textContent = "More Info";
    info.addEventListener("click", () => showInfoDialog(item.name, item.detail));
    tdStatus.appendChild(info);
  }
  // Update now: only for a Portainer server/agent update the integration
  // says it can start itself (`update_now`; an older integration doesn't
  // send it, so those rows keep just More Info and the manual steps). It is
  // confirmed first because Portainer goes away while it updates, and the
  // Updates tab already runs everything else before it for the same reason.
  if (item.update_now && item.entity) {
    const pendingKey = `portainer-update:${item.entity}`;
    const pending = isPending(pendingKey);
    const upd = document.createElement("button");
    upd.className = "row-action-btn";
    upd.textContent = pending ? "Updating…" : "Update now";
    upd.disabled = pending;
    upd.addEventListener("click", () =>
      showConfirmDialog(
        `Update ${item.name} now? Portainer will restart and be unavailable for a minute or two, and this page cannot show progress. Do any other updates first.`,
        "Update now",
        () => runPending(pendingKey, () => updatePortainer(item.entity)),
      ),
    );
    tdStatus.appendChild(upd);
  }
  if (item.dismiss_key) {
    const pendingKey = `dismiss:${item.dismiss_key}`;
    const pending = isPending(pendingKey);
    const dismiss = document.createElement("button");
    dismiss.className = "row-action-btn";
    dismiss.textContent = pending ? "Dismissing…" : "Dismiss";
    dismiss.disabled = pending;
    dismiss.addEventListener("click", () => runPending(pendingKey, () => dismissTroubleItem(item.dismiss_key)));
    tdStatus.appendChild(dismiss);
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
        wireExternalLink(link);
        tdStatus.appendChild(link);
      }

      tr.append(tdCheck, tdName, tdStatus);
      tbody.appendChild(tr);
    }
  }
}

// ---------------------------------------------------------------------
// Cleanup tab -- endpoint -> fixed, ordered actions: Prune dangling images,
// Prune unused images, Prune unused volumes. Each row has its own button
// (acts at once on that one endpoint, after a confirmation) and a checkbox:
// tick any mix of rows, across endpoints, and the action bar's one button runs
// them all (see runCleanupBatch).
//
// History: 1.3.0 had "Clean dangling images" and "Reclaim all images".
// 1.3.3 hid the first because core's portainer.prune_images (pyportainer's
// images_prune()) sent its filters in a shape Docker ignored, so both always
// did the same dangling-only prune (erwindouna/pyportainer#398). That is
// fixed in pyportainer 1.0.47, which Home Assistant 2026.10 ships, so the two
// are different operations again and both are back. The unused-image estimate
// and reclaimable-space badge stay on the "unused" row only: they describe
// every unused image, not the untagged subset (see 1.3.2).
// ---------------------------------------------------------------------

// Order matters: it is the order rows are shown and batch steps are run.
const CLEANUP_ACTIONS = [
  { id: "dangling", label: "Prune dangling images", short: "dangling images", pendingKey: (d) => `cleanup-prune-dangling:${d}` },
  { id: "unused", label: "Prune unused images", short: "unused images", pendingKey: (d) => `cleanup-prune-images:${d}` },
  { id: "volumes", label: "Prune unused volumes", short: "unused volumes", pendingKey: (d) => `cleanup-volumes:${d}` },
];

function cleanupSelId(deviceId, actionId) {
  return `${deviceId}|${actionId}`;
}
function cleanupSelDevice(selId) {
  return selId.slice(0, selId.lastIndexOf("|"));
}
function cleanupSelAction(selId) {
  return selId.slice(selId.lastIndexOf("|") + 1);
}

function mibToCompactGb(mib) {
  if (mib === null || mib === undefined) return null;
  const gb = mib / 1024;
  if (gb < 0.05) return "<0.1 GB";
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

// `pending` is this row's own action running (its button reads pendingText);
// `disabled` additionally greys the button out without changing its text, for
// when a different action on the same endpoint is running. `checkbox` is
// { checked, onChange } or null (an endpoint with no device_id can't be
// selected for a batch).
function renderCleanupActionRow({ label, note, badgeText, buttonText, pendingText, pending, disabled, indent, checkbox, onClick }) {
  const tr = document.createElement("tr");
  if (checkbox && checkbox.checked) tr.classList.add("selected");

  const tdCheck = document.createElement("td");
  if (checkbox) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checkbox.checked;
    cb.addEventListener("change", () => checkbox.onChange(cb.checked));
    tdCheck.appendChild(cb);
  }

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
  btn.disabled = !!(pending || disabled);
  btn.addEventListener("click", () => onClick(btn));
  tdAction.appendChild(btn);

  tr.append(tdCheck, tdName, tdAction);
  return tr;
}

function renderCleanupRows() {
  const tbody = el("rows-cleanup");
  tbody.innerHTML = "";
  const items = state.data.cleanup.items || [];
  if (items.length === 0) {
    tbody.appendChild(emptyRow(3, "No endpoints found."));
    return;
  }

  const sorted = [...items].sort((a, b) => (a.host || "").localeCompare(b.host || ""));
  const singleEndpoint = sorted.length === 1;
  const sel = state.selection.cleanup;

  for (const ep of sorted) {
    const epKey = ep.device_id || ep.host;
    const epSelIds = ep.device_id ? CLEANUP_ACTIONS.map((a) => cleanupSelId(ep.device_id, a.id)) : [];
    if (!singleEndpoint) {
      const epExpanded = !state.collapsedEndpoints.has(`cleanup::${epKey}`);
      const allTicked = epSelIds.length > 0 && epSelIds.every((id) => sel.has(id));
      tbody.appendChild(
        renderGroupHeaderRow({
          label: ep.host,
          // The real per-endpoint figure: the same unused-image estimate
          // the "unused images" row's badge shows (not the number of
          // action rows, which is always the same). null (unknown upstream)
          // falls back to 0 rather than leaving the header blank.
          count: ep.unused_estimate ?? 0,
          indent: false,
          showCheckbox: true,
          checked: allTicked,
          indeterminate: !allTicked && epSelIds.some((id) => sel.has(id)),
          onToggleSelect: (checked) => {
            for (const id of epSelIds) {
              if (checked) sel.add(id);
              else sel.delete(id);
            }
            render();
          },
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
    const unusedRowBadge = [unusedBadge, reclaimBadge].filter(Boolean).join(" · ") || null;

    // All three actions on one endpoint go through the same Portainer
    // connection and the same Cleanup refresh, so while any one is running the
    // others are disabled too (their own buttons keep their normal text).
    const endpointBusy = CLEANUP_ACTIONS.some((a) => isPending(a.pendingKey(ep.device_id)));

    // Both image actions send dangling=<true|false> to
    // portainer_maintenance.prune_images, which core's portainer.prune_images
    // turns into Docker's `dangling` filter. Needs Home Assistant 2026.10 /
    // pyportainer 1.0.47 or later; before that Docker never saw the filter.
    const specs = {
      dangling: {
        note: "Removes only untagged images that no container uses. An image left behind after an update is not always untagged; if it is still listed afterwards, use “Prune unused images”. Needs Home Assistant 2026.10 or later.",
        badgeText: null,
        confirm: `Remove every dangling (untagged, unused) image on ${ep.host}? This cannot be undone.`,
        run: () => pruneImages(true, null, [ep.device_id]),
      },
      unused: {
        note: "Removes every image that no container (running or stopped) is using, tagged or not. Needs Home Assistant 2026.10 or later; before that only untagged images were removed.",
        badgeText: unusedRowBadge,
        confirm: `Remove every unused image on ${ep.host}? This cannot be undone — a container started again afterward will need to re-pull its image.`,
        run: () => pruneImages(false, null, [ep.device_id]),
      },
      volumes: {
        note: "Same action as Portainer's own “Prune unused volumes” button — core's Portainer integration gives limited visibility into what's actually unused.",
        badgeText: null,
        confirm: `Remove every unused Docker volume on ${ep.host}? This cannot be undone.`,
        run: () => pruneVolumes([ep.device_id]),
      },
    };

    for (const action of CLEANUP_ACTIONS) {
      const spec = specs[action.id];
      const pendingKey = action.pendingKey(ep.device_id);
      const selId = ep.device_id ? cleanupSelId(ep.device_id, action.id) : null;
      tbody.appendChild(
        renderCleanupActionRow({
          label: action.label,
          note: spec.note,
          badgeText: spec.badgeText,
          buttonText: "Prune",
          pendingText: "Pruning…",
          pending: isPending(pendingKey),
          disabled: endpointBusy,
          indent,
          checkbox: selId ? { checked: sel.has(selId), onChange: (checked) => toggleSelection("cleanup", selId, checked) } : null,
          onClick: () => {
            showConfirmDialog(spec.confirm, "Prune", () => runPending(pendingKey, spec.run));
          },
        })
      );
    }
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
  const batchKey =
    category === "stale" ? "delete-stale-batch" : category === "cleanup" ? "cleanup-batch" : "install-batch";
  const pending = isPending(batchKey);
  const btn = el("action-btn");
  btn.className = category === "stale" || category === "cleanup" ? "primary-btn danger" : "primary-btn";
  btn.disabled = pending;
  btn.textContent = pending
    ? category === "stale"
      ? `Deleting ${sel.size} device(s)…`
      : category === "cleanup"
        ? `Pruning ${sel.size} item(s)…`
        : `Installing ${sel.size} update(s)…`
    : category === "stale"
      ? `Delete ${sel.size} device(s)`
      : category === "cleanup"
        ? `Prune ${sel.size} selected`
        : `Install ${sel.size} update(s)`;
  btn.onclick = () => {
    if (category === "stale") confirmDeleteSelected();
    else if (category === "cleanup") confirmCleanupBatch();
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
      if (category === "cleanup") {
        if (item.device_id) for (const a of CLEANUP_ACTIONS) state.selection.cleanup.add(cleanupSelId(item.device_id, a.id));
        continue;
      }
      const id = category === "stale" ? staleDeviceId(item) : item.entity;
      if (id) state.selection[category].add(id);
    }
  } else {
    state.selection[category].clear();
  }
  render();
}

// (1.3.5) Install used to be one blocking POST that processed the
// whole selected batch sequentially inside a single HTTP request -- a big
// batch, or one slow item in it, could hold that one connection open for
// minutes, at the mercy of whatever reverse proxy or browser timeout sits
// in front of this app. That's what actually broke a large non-stack
// batch reported in the field: not "too many concurrent updates" (nothing
// here has ever sent Portainer more than one recreate at a time), but one
// long-lived request outliving an unrelated timeout somewhere upstream,
// which then reported the *entire* batch as failed even while the
// server-side loop was still correctly working through it.
//
// Now: submit the batch, get a job id per update back almost immediately,
// then poll for status. The backend queues jobs one-per-Portainer-endpoint
// (see main.py's _run_endpoint_queue) -- a batch spanning multiple
// endpoints runs those endpoints concurrently, but a single endpoint's
// updates still go out strictly one at a time, same as before. Each row's
// "Installing…" state clears the moment ITS OWN job resolves, not when the
// slowest job in the whole batch finally does.
const INSTALL_POLL_INTERVAL_MS = 2000;
const INSTALL_POLL_MAX_MS = 20 * 60 * 1000;
// 20 minutes -- comfortably longer than any legitimate job (a pull+recreate,
// plus up to the integration's own 150s stack-restart-detection watch for a
// stack member), short enough that a job stuck behind a dead endpoint
// worker doesn't leave this tab polling forever.

function endpointKeyForUpdateEntity(entityId) {
  const item = (state.data.updates.items || []).find((i) => i.entity === entityId);
  return (item && (item.host_device_id || item.host)) || "__unknown__";
}

async function installUpdates(entityIds) {
  if (entityIds.length === 0) return;
  showToast(`Installing ${entityIds.length} update(s)…`);

  let jobIds;
  try {
    const res = await fetch("/api/actions/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updates: entityIds.map((id) => ({ entity_id: id, endpoint_key: endpointKeyForUpdateEntity(id) })),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ({ job_ids: jobIds } = await res.json());
  } catch (e) {
    showToast("Install failed to submit — see console");
    console.error(e);
    loadActionItems();
    return;
  }

  // job_ids comes back in the same order entityIds was submitted in.
  const jobs = jobIds.map((jobId, i) => ({ jobId, entityId: entityIds[i], done: false }));
  const errors = [];
  const timedOut = [];
  const needsStackRestart = [];
  const deadline = Date.now() + INSTALL_POLL_MAX_MS;

  while (jobs.some((j) => !j.done) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, INSTALL_POLL_INTERVAL_MS));
    const pendingIds = jobs.filter((j) => !j.done).map((j) => j.jobId);
    if (pendingIds.length === 0) break;
    let statusResult;
    try {
      const res = await fetch(`/api/actions/install/status?job_ids=${encodeURIComponent(pendingIds.join(","))}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      statusResult = await res.json();
    } catch (e) {
      // A poll failing doesn't mean the jobs themselves failed -- keep
      // trying on the next tick rather than giving up on jobs that may
      // well still be progressing server-side.
      console.error(e);
      continue;
    }
    for (const s of statusResult.jobs || []) {
      const job = jobs.find((j) => j.jobId === s.id);
      if (!job || job.done || s.status === "queued" || s.status === "running") continue;
      job.done = true;
      state.selection.updates.delete(job.entityId);
      state.pendingActions.delete(`install:${job.entityId}`);
      if (s.status === "succeeded") {
        if (s.needs_stack_restart) needsStackRestart.push(job.entityId);
      } else if (s.status === "timed_out") {
        timedOut.push(job.entityId);
      } else {
        errors.push(job.entityId);
      }
      render();
    }
  }

  // Anything still not done at this point hit the client-side poll cap --
  // clear its busy state too rather than leaving the row stuck on
  // "Installing…" forever; its outcome is unknown from here, not a
  // confirmed failure, but there's nothing more productive to wait for.
  for (const job of jobs) {
    if (job.done) continue;
    job.done = true;
    state.selection.updates.delete(job.entityId);
    state.pendingActions.delete(`install:${job.entityId}`);
    timedOut.push(job.entityId);
  }

  if (errors.length > 0 || timedOut.length > 0) {
    const parts = [];
    if (errors.length > 0) parts.push(`${errors.length} error(s)`);
    if (timedOut.length > 0) parts.push(`${timedOut.length} timed out`);
    showToast(`Done with ${parts.join(", ")} — check backend logs`);
  } else if (needsStackRestart.length > 0) {
    // (1.3.0) No persistent banner -- a one-time toast pointing at the
    // Trouble tab, which is where the actual remediation now lives (see
    // renderTroubleRows above). Trouble picks this up on its own next
    // poll without anything special needed here.
    showToast(`Installed ${entityIds.length} update(s) — a stack needs a restart, see the Needs Remediation tab`);
  } else {
    showToast(`Installed ${entityIds.length} update(s)`);
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

async function dismissTroubleItem(dismissKey) {
  try {
    const res = await fetch("/api/actions/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismiss_key: dismissKey }),
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
    showToast("Dismissed");
  } catch (e) {
    showToast(`Dismiss failed — ${e.message}`);
    console.error(e);
  }
  await loadActionItems();
}

async function updatePortainer(entityId) {
  try {
    const res = await fetch("/api/actions/update-portainer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_entity: entityId }),
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
    // The row stays until the integration stops listing it; this only means
    // the helper container started, not that Portainer has finished.
    showToast("Updater started — Portainer will restart");
  } catch (e) {
    showToast(`Portainer update failed — ${e.message}`);
    console.error(e);
  }
  await loadActionItems();
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

// ---- Cleanup batch (ticked rows -> one run) ----
//
// Turns the ticked rows into an ordered list of steps: endpoints in the same
// order as the table, and within one endpoint dangling -> unused -> volumes.
// Where "unused images" is ticked, "dangling images" is not run on its own: it
// is a subset, so a second pass would only repeat the same work.
function cleanupBatchPlan(ids) {
  const hosts = new Map((state.data.cleanup.items || []).map((ep) => [ep.device_id, ep.host]));
  const perDevice = new Map();
  for (const id of ids) {
    const device = cleanupSelDevice(id);
    if (!hosts.has(device)) continue;
    if (!perDevice.has(device)) perDevice.set(device, new Set());
    perDevice.get(device).add(cleanupSelAction(id));
  }
  const steps = [];
  let covered = 0;
  const ordered = [...perDevice.entries()].sort((a, b) => (hosts.get(a[0]) || "").localeCompare(hosts.get(b[0]) || ""));
  for (const [device, actions] of ordered) {
    for (const action of CLEANUP_ACTIONS) {
      if (!actions.has(action.id)) continue;
      if (action.id === "dangling" && actions.has("unused")) {
        covered++;
        continue;
      }
      steps.push({ deviceId: device, host: hosts.get(device), action: action.id });
    }
  }
  return { steps, covered };
}

function describeCleanupSteps(steps) {
  const parts = [];
  for (const action of CLEANUP_ACTIONS) {
    const hostNames = steps.filter((s) => s.action === action.id).map((s) => s.host);
    if (hostNames.length) parts.push(`${action.short} on ${hostNames.join(", ")}`);
  }
  return parts.join("; ");
}

function confirmCleanupBatch() {
  const { steps, covered } = cleanupBatchPlan([...state.selection.cleanup]);
  if (steps.length === 0) return;
  let text = `Prune ${describeCleanupSteps(steps)}? This cannot be undone.`;
  if (covered > 0) {
    text += " Dangling images are not run separately where all unused images are pruned, since that already includes them.";
  }
  showConfirmDialog(text, "Prune", () => runPending("cleanup-batch", () => runCleanupBatch()));
}

async function postCleanupStep(step) {
  const volumes = step.action === "volumes";
  const body = volumes
    ? { device_ids: [step.deviceId] }
    : { dangling: step.action === "dangling", until_hours: null, device_ids: [step.deviceId] };
  try {
    const res = await fetch(volumes ? "/api/actions/prune-volumes" : "/api/actions/prune-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

// One step at a time, never in parallel: two actions on the same endpoint
// share one Portainer connection and one Cleanup refresh (see the busy rule in
// renderCleanupRows), and each request is the same single-endpoint call the
// per-row buttons make, so it keeps their timeout. Every row in the batch shows
// busy from the start, then frees up as its own step finishes. Ticks for steps
// that succeeded are cleared; a failed step stays ticked so it can be retried.
async function runCleanupBatch() {
  const { steps } = cleanupBatchPlan([...state.selection.cleanup]);
  const keyOf = (s) => CLEANUP_ACTIONS.find((a) => a.id === s.action).pendingKey(s.deviceId);
  for (const s of steps) state.pendingActions.add(keyOf(s));
  render();
  showToast(`Pruning ${steps.length} item${steps.length === 1 ? "" : "s"}…`);
  let failed = 0;
  for (const s of steps) {
    const ok = await postCleanupStep(s);
    state.pendingActions.delete(keyOf(s));
    if (ok) {
      state.selection.cleanup.delete(cleanupSelId(s.deviceId, s.action));
      if (s.action === "unused") state.selection.cleanup.delete(cleanupSelId(s.deviceId, "dangling"));
    } else {
      failed++;
    }
    render();
  }
  showToast(failed === 0 ? `Prune requested: ${steps.length} item${steps.length === 1 ? "" : "s"}` : `${failed} of ${steps.length} failed — see console`);
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
  hideAllDialogs();
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
  hideAllDialogs();
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
// Opening the dashboard counts as having read Home Assistant's "Portainer is
// reporting ..." bell notification, so ask the backend to dismiss it. Best
// effort: nothing here depends on the answer.
fetch("/api/panel-opened", { method: "POST" }).catch(() => {});
loadActionItems();
setInterval(loadActionItems, REFRESH_MS);
