// Portainer Sidecar frontend.
//
// Reads the four HA tracking sensors (sensor.portainer_updates_pending,
// sensor.portainer_trouble, sensor.portainer_stale_devices,
// sensor.portainer_cleanup) via this app's own backend, which proxies HA's
// REST API, and renders four endpoint-grouped tree tabs. See main.py for
// the API this talks to.

const REFRESH_MS = 15000;

// Phone width: the same breakpoint as the phone rules in style.css. The Updates
// rows pick their layout from it (see renderUpdateChildRow); crossing it, for
// example by rotating the phone, re-renders (see the listener near setupTabs).
const PHONE_MQ =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 480px)")
    : { matches: false, addEventListener() {} };

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
  // The "Update dashboard" row's Restart Home Assistant button: until this time
  // (ms since the epoch) the restart counts as under way and the row says so.
  // haSeenDown notes that a refresh failed since (Home Assistant went down), so
  // the next one that works means it is back. See restartHomeAssistant.
  haRestartingUntil: 0,
  haSeenDown: false,
  // dismiss_key -> time it was clicked, for Trouble rows hidden optimistically
  // (see dismissTroubleItem / troubleView).
  dismissedTrouble: new Map(),
  // (1.3.1) A failed "Restart Stack Now" gets a persistent inline error on
  // the Trouble tab's stack row, not just a toast -- this is the one action
  // in the whole app where a silent failure is actively misleading (tap it,
  // assume the stack recovered, walk away). Keyed by switch_entity_id;
  // cleared on the next successful restart of that stack, or dropped by
  // pruneStackRestartErrors() once that stack no longer shows a
  // stack_restart_needed item at all (resolved some other way -- manual
  // Portainer intervention, an endpoint reload, etc).
  stackRestartErrors: new Map(),
  // Outcome of the last install attempt per update entity, keyed by
  // entity id: { kind: "installed" | "failed" | "timed_out" | "unknown" |
  // "restarted", message, detail, needsStackRestart, at }. A row renders from this
  // (not just from pendingActions) so that when a job resolves the row
  // moves straight from "Installing..." to a visible result instead of
  // falling back to "Install" until the next fetch. See
  // pruneInstallResults() for when an entry is dropped.
  installResults: new Map(),
  // Cleanup: endpoints whose numbers disagree about whether there is anything
  // for the image prunes to remove, keyed by the endpoint's device_id, with
  // the dashboard refreshes (their `refreshed_at` stamps) that showed the
  // disagreement. See imagePruneBlock / trackPruneConflicts.
  pruneConflict: new Map(),
  // Stale Devices: device_id -> time it was deleted here, for devices whose
  // delete succeeded but which the server may still list for a moment. They
  // stay hidden until the server stops listing them. See deleteStaleDevices /
  // staleView.
  deletedStale: new Map(),
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
    if (state.haSeenDown || !(state.data.trouble.items || []).some((i) => i.kind === "dashboard_update")) {
      // Home Assistant is back (or the row is gone): the restart is over.
      state.haRestartingUntil = 0;
      state.haSeenDown = false;
    }
    trackPruneConflicts();
    pruneDismissedTrouble();
    pruneDeletedStale();
    pruneSelection();
    pruneStackRestartErrors();
    pruneInstallResults();
    render();
    el("last-updated").textContent = "Updated " + new Date().toLocaleTimeString();
  } catch (e) {
    el("last-updated").textContent = "Refresh failed — will retry";
    if (state.haRestartingUntil > Date.now()) state.haSeenDown = true;
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
  // Also drops a tick whose row has become unavailable since (the endpoint's
  // last image was pruned, so its image rows are now disabled).
  const cleanupSelectable = new Set((state.data.cleanup.items || []).flatMap((ep) => cleanupSelectableIds(ep)));
  for (const id of [...state.selection.cleanup]) {
    if (!cleanupSelectable.has(id)) state.selection.cleanup.delete(id);
  }
}

function staleDeviceId(item) {
  return item?.device_id || null;
}

// How long an "Installed" row is held while the server data still lists
// the update. Core's update entity can take several minutes to settle after a
// recreate (it goes on -> unknown -> off), and until it does the integration
// still lists the update; releasing the row earlier offered Install again for
// an update that had already been applied. Seven minutes matches how long the
// integration keeps an update listed as `confirming` (see below). The cap
// only matters if the server keeps listing it, so the row falls back to
// what the server says rather than claiming "Installed" forever.
const INSTALLED_HOLD_MS = 420000;

// Drop an install result once the server data has caught up with it:
//   - the update is no longer listed -> the outcome is confirmed (an
//     installed row simply disappears; a failed row has nothing left to
//     retry because the server no longer offers the update), or
//   - an "Installed" or "Restarted" row has been waiting longer than
//     INSTALLED_HOLD_MS, unless the integration still flags the update
//     `confirming` (core's update entity is "unknown": the container is being
//     recreated and core has not yet said whether it took), in which case the
//     integration's own cap decides.
// A failed / timed_out / unknown result otherwise stays until the user
// retries it.
function pruneInstallResults() {
  if (state.installResults.size === 0) return;
  const listedItems = new Map((state.data.updates.items || []).map((i) => [i.entity, i]));
  const now = Date.now();
  for (const [entityId, result] of [...state.installResults]) {
    const listed = listedItems.get(entityId);
    if (!listed) state.installResults.delete(entityId);
    else if (
      (result.kind === "installed" || result.kind === "restarted") &&
      !listed.confirming &&
      now - result.at > INSTALLED_HOLD_MS
    ) {
      state.installResults.delete(entityId);
    }
  }
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

// How long a dismissed Trouble row stays hidden while the server still lists
// it. Normally the next refresh drops it (the integration refreshes right
// after a dismiss); this cap only matters if it never does, so the row comes
// back rather than staying hidden against what the server says.
const DISMISS_HOLD_MS = 120000;

// Forget dismissed keys the server has stopped listing, or has listed for
// longer than DISMISS_HOLD_MS. Run on fresh data, before it is displayed.
function pruneDismissedTrouble() {
  const listed = new Set((state.data.trouble.items || []).map((i) => i.dismiss_key).filter(Boolean));
  const now = Date.now();
  for (const [key, at] of [...state.dismissedTrouble]) {
    if (!listed.has(key) || now - at > DISMISS_HOLD_MS) state.dismissedTrouble.delete(key);
  }
}

// The Trouble data as displayed: the server's list minus rows dismissed here
// and not yet confirmed gone, with the count adjusted to match.
function troubleView() {
  const raw = state.data.trouble;
  const items = raw.items || [];
  if (state.dismissedTrouble.size === 0) return { count: raw.count, items };
  const kept = items.filter((i) => !(i.dismiss_key && state.dismissedTrouble.has(i.dismiss_key)));
  return { count: Math.max(0, raw.count - (items.length - kept.length)), items: kept };
}

// How long a deleted Stale device stays hidden while the server still lists it.
// Normally the next refresh stops listing it (the integration re-scans when a
// device is removed); this cap only matters if it never does, so the row comes
// back rather than staying hidden against what the server says.
const DELETED_HOLD_MS = 120000;

// Forget deleted devices the server has stopped listing, or has listed for
// longer than DELETED_HOLD_MS. Run on fresh data, before it is displayed.
function pruneDeletedStale() {
  const listed = new Set((state.data.stale.items || []).map((i) => staleDeviceId(i)).filter(Boolean));
  const now = Date.now();
  for (const [id, at] of [...state.deletedStale]) {
    if (!listed.has(id) || now - at > DELETED_HOLD_MS) state.deletedStale.delete(id);
  }
}

// The Stale data as displayed: the server's list minus devices deleted here and
// not yet confirmed gone, with the count adjusted to match.
function staleView() {
  const raw = state.data.stale;
  const items = raw.items || [];
  if (state.deletedStale.size === 0) return { count: raw.count, items };
  const kept = items.filter((i) => !state.deletedStale.has(staleDeviceId(i)));
  return { count: Math.max(0, raw.count - (items.length - kept.length)), items: kept };
}

function render() {
  const trouble = troubleView();
  const stale = staleView();
  setTabCount("count-updates", "updates", state.data.updates.count);
  setTabCount("count-trouble", "trouble", trouble.count);
  setTabCount("count-stale", "stale", stale.count);
  // (1.3.0) Cleanup's sensor state is a running SUM of the per-endpoint
  // unused-image estimate, not an item count -- see sensor.py's
  // PortainerCleanupCoordinator. Still the right number for the tab
  // badge: "how many unused images across every host," same idea as the
  // other three counts, just not len(items) under the hood.
  setTabCount("count-cleanup", "cleanup", state.data.cleanup.count);

  const totalCount =
    state.data.updates.count + trouble.count + stale.count + state.data.cleanup.count;
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

// The description line under a row's name: "Update available" when there's no
// install result, otherwise the outcome of the last attempt. It sits under the
// name, indented with it (the same layout as the Needs Remediation and Stale
// Devices rows), so the Status cell is left to the buttons.
function installResultStatus(result, indentClass, confirming = false) {
  const line = document.createElement("div");
  line.className = `row-secondary ${indentClass}`;
  if (!result) {
    // `confirming`: the integration lists the update only because core's
    // update entity is "unknown" right after being "on", i.e. the container
    // is being recreated (from here, or from Portainer's own UI).
    line.textContent = confirming ? "Update applied — confirming…" : "Update available";
    return line;
  }
  if (result.kind === "installed") {
    line.textContent = result.needsStackRestart
      ? "Installed — stack needs a restart, see the Needs Remediation tab"
      : "Installed — confirming…";
    return line;
  }
  line.textContent = result.message;
  line.title = result.detail || result.message;
  // This app restarting to apply its own update is the expected outcome, not
  // a warning: plain muted text.
  if (result.kind === "restarted") return line;
  line.style.fontWeight = "500";
  // A confirmed failure is red; a timeout or lost job is "outcome unknown",
  // which is a warning, not a verdict.
  line.style.color = result.kind === "failed" ? "var(--danger)" : "var(--warn)";
  return line;
}

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
  let descLine = null;

  const tdStatus = document.createElement("td");
  const actions = document.createElement("div");
  actions.className = "row-actions";
  const installKey = `install:${item.entity}`;
  const installPending = isPending(installKey);
  let installResult = installPending ? null : state.installResults.get(item.entity) || null;
  // Core says the container is being recreated (see pruneInstallResults): a
  // timed-out or lost job is no longer "outcome unknown", and with no result
  // at all this was started somewhere else. Either way, don't offer Install
  // again. A confirmed failure keeps its Retry.
  const confirming =
    !installPending && !!item.confirming && !(installResult && ["installed", "restarted", "failed"].includes(installResult.kind));
  if (confirming) installResult = null;
  const installBtn = document.createElement("button");
  installBtn.className = "row-action-btn";
  if (installPending) {
    installBtn.textContent = "Installing…";
    installBtn.disabled = true;
  } else if (confirming) {
    installBtn.textContent = "Confirming…";
    installBtn.disabled = true;
  } else if (installResult && installResult.kind === "installed") {
    installBtn.textContent = "Installed";
    installBtn.disabled = true;
  } else if (installResult && installResult.kind === "restarted") {
    installBtn.textContent = "Restarted";
    installBtn.disabled = true;
  } else if (installResult) {
    installBtn.textContent = "Retry";
  } else {
    installBtn.textContent = "Install";
  }
  installBtn.addEventListener("click", () => {
    state.installResults.delete(item.entity);
    runPending(installKey, () => installUpdates([item.entity]));
  });
  descLine = installResultStatus(installResult, indentClass, confirming);
  actions.appendChild(installBtn);
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
    actions.appendChild(changelogBtn);
  } else if (item.changelog_url) {
    const changelogLink = document.createElement("a");
    changelogLink.className = "row-changelog-link";
    changelogLink.href = item.changelog_url;
    changelogLink.target = "_blank";
    changelogLink.rel = "noopener";
    changelogLink.textContent = "Changelog";
    wireExternalLink(changelogLink);
    actions.appendChild(changelogLink);
  }
  tdStatus.appendChild(actions);

  if (PHONE_MQ.matches) {
    // Phone: the name gets its own full-width line at the top, so a long name
    // such as immich_machine_learning (drakebay) wraps at its space instead of
    // being squeezed between the checkbox and the buttons. Two table rows: the
    // title (checkbox on the left spanning both rows, name across the other two
    // columns), then the description with the buttons beside it.
    tr.classList.add("update-row-title");
    tdCheck.rowSpan = 2;
    tdName.colSpan = 2;
    tr.append(tdCheck, tdName);
    const trDetail = document.createElement("tr");
    trDetail.className = "stack-child-row update-row-detail";
    if (tr.classList.contains("selected")) trDetail.classList.add("selected");
    const tdDesc = document.createElement("td");
    tdDesc.appendChild(descLine);
    trDetail.append(tdDesc, tdStatus);
    const pair = document.createDocumentFragment();
    pair.append(tr, trDetail);
    return pair;
  }

  tdName.appendChild(descLine);
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
  // The description sits on its own line under the name, indented with it,
  // so the Status cell is free for the buttons (on a phone the two used to
  // fight over one narrow column).
  let nameHtml = `<div class="row-name ${indentClass}">${escapeHtml(item.name)}</div>`;
  // A Portainer self-update the integration is tracking says where it is in
  // `update_state` ("updating" or "failed"; absent from an older integration)
  // and puts the matching text in `secondary_info`. A failed one is shown red.
  const updateFailed = item.update_state === "failed";
  if (item.secondary_info) {
    nameHtml += `<div class="row-secondary ${indentClass}${updateFailed ? " row-secondary-failed" : ""}">${escapeHtml(item.secondary_info)}</div>`;
  }
  tdName.innerHTML = nameHtml;
  const tdStatus = document.createElement("td");
  const actions = document.createElement("div");
  actions.className = "row-actions";

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
    actions.appendChild(info);
  }
  // Update now: only for a Portainer server/agent update the integration
  // says it can start itself (`update_now`; an older integration doesn't
  // send it, so those rows keep just More Info and the manual steps). It is
  // confirmed first because Portainer goes away while it updates, and the
  // Updates tab already runs everything else before it for the same reason.
  // While the integration is tracking a started update (`update_state` is
  // "updating") the button stays as a disabled "Updating…" until the
  // integration reports the outcome, however long that takes, instead of
  // going back to "Update now" a second after the click.
  const updateRunning = item.update_state === "updating";
  if ((item.update_now || updateRunning) && item.entity) {
    const pendingKey = `portainer-update:${item.entity}`;
    const pending = isPending(pendingKey) || updateRunning;
    const upd = document.createElement("button");
    upd.className = "row-action-btn";
    upd.textContent = pending ? "Updating…" : "Update now";
    upd.disabled = pending;
    upd.addEventListener("click", () =>
      showConfirmDialog(
        `Update ${item.name} now? Portainer will restart and be unavailable for a minute or two; the row shows how it is going. Do any other updates first.`,
        "Update now",
        () => runPending(pendingKey, () => updatePortainer(item.entity)),
      ),
    );
    actions.appendChild(upd);
  }
  // Dismiss changes no state anywhere except "hide this row", so the row goes
  // at once and the request runs in the background (see dismissTroubleItem).
  if (item.dismiss_key) {
    const dismiss = document.createElement("button");
    dismiss.className = "row-action-btn";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => dismissTroubleItem(item.dismiss_key));
    actions.appendChild(dismiss);
  }
  if (actions.childElementCount > 0) tdStatus.appendChild(actions);

  tr.append(tdName, tdStatus);
  return tr;
}

// The sidecar's own "the dashboard integration is too old for me" row (see
// dashboard_compat in main.py). `item.action` says which button it gets:
// "update" downloads the newer integration through HACS, "restart" restarts
// Home Assistant (after a confirmation: everything in it is down for a minute
// or two). With neither, the row only explains.
function renderDashboardUpdateRow(item) {
  const tr = document.createElement("tr");
  const tdName = document.createElement("td");
  const restarting = state.haRestartingUntil > Date.now();
  const secondary = restarting
    ? "Home Assistant is restarting. This row goes away once it is back on the new version."
    : item.secondary_info;
  let nameHtml = `<div class="row-name">${escapeHtml(item.name)}</div>`;
  if (secondary) nameHtml += `<div class="row-secondary">${escapeHtml(secondary)}</div>`;
  tdName.innerHTML = nameHtml;
  const tdStatus = document.createElement("td");
  const actions = document.createElement("div");
  actions.className = "row-actions";

  if (item.detail) {
    const info = document.createElement("button");
    info.className = "row-action-btn";
    info.textContent = "More Info";
    info.addEventListener("click", () => showInfoDialog(item.name, item.detail));
    actions.appendChild(info);
  }

  const button = (text, disabled, onClick) => {
    const b = document.createElement("button");
    b.className = "row-action-btn";
    b.textContent = text;
    b.disabled = disabled;
    if (onClick) b.addEventListener("click", onClick);
    actions.appendChild(b);
  };
  if (restarting) {
    button("Restarting…", true);
  } else if (item.action === "update") {
    const pending = isPending("dashboard-update");
    button(pending ? "Updating…" : "Update dashboard", pending, () =>
      runPending("dashboard-update", updateDashboard),
    );
  } else if (item.action === "restart") {
    const pending = isPending("restart-ha");
    button(pending ? "Restarting…" : "Restart HA", pending, () =>
      showConfirmDialog(
        "Restart Home Assistant now? Everything in it, automations and notifications included, is unavailable for a minute or two, and this page cannot refresh until it is back.",
        "Restart",
        () => runPending("restart-ha", restartHomeAssistant),
      ),
    );
  } else if (item.phase === "installing") {
    button("Updating…", true);
  }
  if (actions.childElementCount > 0) tdStatus.appendChild(actions);

  tr.append(tdName, tdStatus);
  return tr;
}

async function updateDashboard() {
  showToast("Downloading the dashboard integration through HACS…");
  try {
    const res = await fetch("/api/actions/update-dashboard", { method: "POST" });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).detail || "";
      } catch {
        // Response wasn't JSON -- fall through with just the status.
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    showToast("Downloaded — restart Home Assistant to finish");
  } catch (e) {
    showToast(`Update failed — ${e.message}`);
    console.error(e);
  }
  await loadActionItems();
}

// How long the row keeps saying "restarting" if Home Assistant never shows
// itself going down and coming back (normally it clears on that).
const HA_RESTART_HOLD_MS = 180000;

async function restartHomeAssistant() {
  showToast("Restarting Home Assistant…");
  try {
    const res = await fetch("/api/actions/restart-ha", { method: "POST" });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).detail || "";
      } catch {
        // Response wasn't JSON -- fall through with just the status.
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    state.haRestartingUntil = Date.now() + HA_RESTART_HOLD_MS;
    state.haSeenDown = false;
    showToast("Home Assistant restart requested");
  } catch (e) {
    showToast(`Restart failed — ${e.message}`);
    console.error(e);
  }
  await loadActionItems();
}

function renderTroubleRows() {
  const tbody = el("rows-trouble");
  tbody.innerHTML = "";
  const items = troubleView().items;
  if (items.length === 0) {
    tbody.appendChild(emptyRow(2, "Nothing in trouble."));
    return;
  }

  // The "Update dashboard" row belongs to no endpoint: it goes first, above
  // the endpoint tree.
  for (const item of items.filter((i) => i.kind === "dashboard_update")) {
    tbody.appendChild(renderDashboardUpdateRow(item));
  }
  const treeItems = items.filter((i) => i.kind !== "dashboard_update");
  const endpointItems = treeItems.filter((i) => i.kind === "endpoint");
  const otherItems = treeItems.filter((i) => i.kind !== "endpoint");
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
  const items = staleView().items;
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

      // The description sits on its own line under the name, indented with
      // it (the same layout as the Needs Remediation rows), so the Status
      // cell is free for the button.
      const tdName = document.createElement("td");
      const indentClass = singleEndpoint ? "" : "row-name-indent";
      let nameHtml = `<div class="row-name ${indentClass}">${escapeHtml(item.name)}</div>`;
      if (item.secondary_info) nameHtml += `<div class="row-secondary ${indentClass}">${escapeHtml(item.secondary_info)}</div>`;
      tdName.innerHTML = nameHtml;

      // Delete removes the device from Home Assistant's device registry (the
      // same call the action bar makes for ticked rows), after a
      // confirmation. It replaced a "Review" link that opened the device
      // page in a new browser window and asked for a login.
      const tdStatus = document.createElement("td");
      if (deviceId) {
        const pendingKey = `delete-stale:${deviceId}`;
        const pending = isPending(pendingKey);
        const actions = document.createElement("div");
        actions.className = "row-actions";
        const del = document.createElement("button");
        del.className = "row-action-btn";
        del.textContent = pending ? "Deleting…" : "Delete";
        del.disabled = pending || isPending("delete-stale-batch");
        del.addEventListener("click", () =>
          showConfirmDialog(
            `Permanently delete ${item.name}${ep.host ? ` (${ep.host})` : ""}? This cannot be undone.`,
            "Delete",
            () => runPending(pendingKey, () => deleteStaleDevices([deviceId]))
          )
        );
        actions.appendChild(del);
        tdStatus.appendChild(actions);
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

// Whether the two image prunes are available for an endpoint. They are off
// (and can't be ticked or batch-run) when `imagePruneBlock` says why:
//   "computing"   the dashboard says this host's numbers are not ready yet
//                 (`status: "computing"`: right after a restart its image
//                 count, container count or reclaimable space has no usable
//                 state yet). The numbers on the item are about to change.
//   "unavailable" `status: "unavailable"`: the host was still not ready when
//                 the dashboard's 5-minute backstop re-read ran. (Also, below,
//                 `reclaimable_unavailable`.)
//   "no-images"   `images_count` (every image on the endpoint, dangling ones
//                 included) is 0.
//   "unavailable" `reclaimable_unavailable`: the integration found core's
//                 reclaimable-space sensor but it is unavailable. The state is
//                 not known, so no action is offered.
//   "nothing"     the unused-image count the row shows (`unused_estimate`:
//                 images minus containers) is 0, which is what a prune leaves
//                 behind since the images running containers use stay, unless
//                 the byte-accurate `reclaimable_mib` is above 0 (the estimate
//                 reads 0 when containers share an image even though one image
//                 is unused). The integration sends 0 for a reclaimable sensor
//                 that is Unknown (core reports Unknown when nothing can be
//                 reclaimed) and null when the sensor doesn't exist at all;
//                 both count as 0 here.
//   "settling"    the count says there are unused images but reclaimable says
//                 0. That is most likely the two sensors being read at
//                 different moments, so the prunes stay off until a second
//                 dashboard refresh shows the same thing, then the count wins
//                 and they turn on. (The page re-reads every 15 s but the
//                 dashboard only refreshes its Cleanup numbers every few
//                 minutes, so it counts refreshes by their `refreshed_at`
//                 stamp, not page polls.)
// A dashboard integration too old to send these (including `status`), or an
// unknown count, leaves the rows enabled. Volumes are not affected: they are a
// separate prune.
//
// `status` is the dashboard's own per-host verdict and wins over the rest: a
// host that is computing or unavailable shows no numbers-based reason at all.
// The "checking…" settling below is separate and sidecar-only: it covers two
// numbers of a *ready* host that disagree.
function hostNotReady(ep) {
  return ep.status === "computing" || ep.status === "unavailable";
}

function imagePruneConflict(ep) {
  return (
    ep.images_count !== 0 &&
    !ep.reclaimable_unavailable &&
    typeof ep.unused_estimate === "number" &&
    ep.unused_estimate > 0 &&
    !(ep.reclaimable_mib > 0) &&
    !!ep.refreshed_at
  );
}

function imagePruneBlock(ep) {
  if (ep.status === "computing") return "computing";
  if (ep.status === "unavailable") return "unavailable";
  if (ep.images_count === 0) return "no-images";
  if (ep.reclaimable_unavailable) return "unavailable";
  if (ep.unused_estimate === 0 && !(ep.reclaimable_mib > 0)) return "nothing";
  if (imagePruneConflict(ep)) {
    const rec = state.pruneConflict.get(ep.device_id || ep.host);
    if (!rec || rec.refreshes.size < 2) return "settling";
  }
  return null;
}

function imagePruneHasNothingToDo(ep) {
  return imagePruneBlock(ep) !== null;
}

// Called after each fetch, before anything renders from the new data.
function trackPruneConflicts() {
  const live = new Set();
  for (const ep of state.data.cleanup.items || []) {
    if (hostNotReady(ep) || !imagePruneConflict(ep)) continue;
    const key = ep.device_id || ep.host;
    live.add(key);
    const rec = state.pruneConflict.get(key);
    if (rec) rec.refreshes.add(ep.refreshed_at);
    else state.pruneConflict.set(key, { refreshes: new Set([ep.refreshed_at]) });
  }
  for (const key of [...state.pruneConflict.keys()]) {
    if (!live.has(key)) state.pruneConflict.delete(key);
  }
}

function cleanupActionDisabled(ep, actionId) {
  return (actionId === "dangling" || actionId === "unused") && imagePruneHasNothingToDo(ep);
}

// Prune actions that can't run at the same time on one endpoint. The two image
// prunes both remove images, so while one runs the other waits; the volume
// prune is independent of them and of each other group.
const CLEANUP_IMAGE_ACTIONS = ["dangling", "unused"];
function cleanupActionGroup(actionId) {
  return CLEANUP_IMAGE_ACTIONS.includes(actionId) ? CLEANUP_IMAGE_ACTIONS : [actionId];
}

// The tick ids a row, header or "select all" may set for this endpoint.
function cleanupSelectableIds(ep) {
  if (!ep.device_id) return [];
  return CLEANUP_ACTIONS.filter((a) => !cleanupActionDisabled(ep, a.id)).map((a) => cleanupSelId(ep.device_id, a.id));
}

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
// { checked, disabled, onChange } or null (an endpoint with no device_id can't be
// selected for a batch).
function renderCleanupActionRow({ label, note, badgeText, buttonText, pendingText, pending, disabled, indent, checkbox, onClick }) {
  const tr = document.createElement("tr");
  if (checkbox && checkbox.checked) tr.classList.add("selected");

  const tdCheck = document.createElement("td");
  if (checkbox) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checkbox.checked;
    cb.disabled = !!checkbox.disabled;
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
    const epSelIds = cleanupSelectableIds(ep);
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
          // A host that is not ready counts 0, like the sensor does.
          count: hostNotReady(ep) ? 0 : ep.unused_estimate ?? 0,
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
    const noImages = ep.images_count === 0;
    const pruneBlock = imagePruneBlock(ep);
    const pruneBlockBadge = { computing: "computing…", "no-images": "no images", nothing: "nothing to prune", unavailable: "status unavailable", settling: "checking…" }[pruneBlock] || null;
    const unusedBadge = ep.unused_estimate === null || ep.unused_estimate === undefined ? null : `~${ep.unused_estimate} unused`;
    const reclaimBadge = mibToCompactGb(ep.reclaimable_mib);
    const unusedRowBadge = hostNotReady(ep)
      ? pruneBlockBadge
      : noImages
        ? "no images"
        : pruneBlock === "unavailable" || pruneBlock === "settling"
          ? pruneBlockBadge
          : [unusedBadge, reclaimBadge].filter(Boolean).join(" · ") || null;

    // A running prune disables only the actions it conflicts with (the other
    // image prune), not the volume prune. See cleanupActionGroup.

    // Both image actions send dangling=<true|false> to
    // portainer_maintenance.prune_images, which core's portainer.prune_images
    // turns into Docker's `dangling` filter. Needs Home Assistant 2026.10 /
    // pyportainer 1.0.47 or later; before that Docker never saw the filter.
    const specs = {
      dangling: {
        note: "Removes only untagged images that no container uses, which includes the old image an update leaves behind. “Prune unused images” also removes tagged ones. Needs Home Assistant 2026.10 or later.",
        badgeText: pruneBlockBadge,
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
      const unavailable = cleanupActionDisabled(ep, action.id);
      tbody.appendChild(
        renderCleanupActionRow({
          label: action.label,
          note: spec.note,
          badgeText: spec.badgeText,
          buttonText: "Prune",
          pendingText: "Pruning…",
          pending: isPending(pendingKey),
          disabled: unavailable || cleanupActionGroup(action.id).some((id) => isPending(CLEANUP_ACTIONS.find((a) => a.id === id).pendingKey(ep.device_id))),
          indent,
          checkbox: selId ? { checked: !unavailable && sel.has(selId), disabled: unavailable, onChange: (checked) => toggleSelection("cleanup", selId, checked) } : null,
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
  const items = category === "stale" ? staleView().items : state.data[category].items || [];
  if (checked) {
    for (const item of items) {
      if (category === "cleanup") {
        for (const id of cleanupSelectableIds(item)) state.selection.cleanup.add(id);
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

// Portainer's own container is what performs every other recreate on its
// host, so updating it replaces the actuator mid-batch: the next job would
// start while Portainer is restarting. The backend runs each endpoint's
// jobs strictly in the order they're submitted, so putting Portainer's own
// update last within a batch means nothing else on that host is still
// waiting on it. Matched by container name ("portainer") -- the update item
// only carries the device name, not the image.
function isPortainerOwnUpdate(entityId) {
  const item = (state.data.updates.items || []).find((i) => i.entity === entityId);
  if (!item || !item.name) return false;
  return item.name.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase() === "portainer";
}

function orderPortainerLast(entityIds) {
  return [
    ...entityIds.filter((id) => !isPortainerOwnUpdate(id)),
    ...entityIds.filter((id) => isPortainerOwnUpdate(id)),
  ];
}

// Home Assistant's own update goes after everything else in a batch, and
// only once every other job -- on every endpoint -- has finished. Recreating
// the homeassistant container restarts the thing that is running the
// install (perform_update is a service call into HA), so anything still
// queued or running behind it would be cut off. The backend's per-endpoint
// queues run concurrently across endpoints, so submit order alone can't
// guarantee this; the batch is split into two submissions instead.
// Matched by container name (homeassistant / home-assistant / home_assistant)
// or by the update's changelog repo, because the update item carries no
// image field.
function isHomeAssistantOwnUpdate(entityId) {
  const item = (state.data.updates.items || []).find((i) => i.entity === entityId);
  if (!item) return false;
  if (String(item.changelog_repo || "").toLowerCase() === "home-assistant/core") return true;
  if (!item.name) return false;
  const name = item.name.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
  return name === "homeassistant" || name === "home-assistant" || name === "home_assistant";
}

// This app's own update. Recreating the sidecar's container restarts the very
// process that is tracking the install job, so the job is gone when the page
// next asks about it (see installResultFromJob). Matched by container name
// (ha-portainer-sidecar, as in the README's compose example) or by the update's
// changelog repo, because the update item carries no image field.
function isSidecarOwnUpdate(entityId) {
  const item = (state.data.updates.items || []).find((i) => i.entity === entityId);
  if (!item) return false;
  if (String(item.changelog_repo || "").toLowerCase() === "bdelima/ha-portainer-sidecar") return true;
  if (!item.name) return false;
  const name = item.name.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
  return name === "ha-portainer-sidecar" || name === "ha_portainer_sidecar" || name === "portainer-sidecar";
}

// Splits a batch into submission groups, in the order they must run:
// everything else first (Portainer's own update last within it), then Home
// Assistant. Empty groups are dropped.
function installGroups(entityIds) {
  const ha = entityIds.filter((id) => isHomeAssistantOwnUpdate(id));
  const rest = orderPortainerLast(entityIds.filter((id) => !isHomeAssistantOwnUpdate(id)));
  return [rest, ha].filter((g) => g.length > 0);
}

// Short, single-line version of a backend job error for the row's status
// text. The full text stays available as the row's tooltip.
function shortInstallError(err) {
  const text = String(err || "")
    .replace(/\s+For more information check:.*$/s, "")
    .replace(/\s+for url\s+'[^']*'/i, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "see the sidecar logs";
  return text.length > 100 ? text.slice(0, 100) + "…" : text;
}

function installResultFromJob(job, entityId) {
  const at = Date.now();
  if (job.status === "succeeded") {
    return { kind: "installed", needsStackRestart: !!job.needs_stack_restart, at };
  }
  if (job.status === "timed_out") {
    return {
      kind: "timed_out",
      message: "Timed out — outcome unknown, check before retrying",
      detail: job.error || "",
      at,
    };
  }
  if (job.status === "unknown" && isSidecarOwnUpdate(entityId)) {
    // The job lives in this app's memory, and updating this app restarts it,
    // so losing the job is what a sidecar update looks like from here. Not a
    // problem and nothing to check.
    return {
      kind: "restarted",
      message: "Restarted to apply its own update, so the install status was lost. That is expected; this row clears once Home Assistant sees the new version.",
      detail: "",
      at,
    };
  }
  if (job.status === "unknown") {
    return {
      kind: "unknown",
      message: "Status lost (job expired or the app restarted) — check before retrying",
      detail: job.error || "",
      at,
    };
  }
  return { kind: "failed", message: `Failed — ${shortInstallError(job.error)}`, detail: job.error || "", at };
}

// Submits one group of updates and polls it to completion. Returns the
// outcome lists so installUpdates can report one summary for the whole
// batch (which may be several groups run back to back).
async function runInstallGroup(entityIds) {
  const outcome = { errors: [], timedOut: [], needsStackRestart: [], selfRestarted: [], submitFailed: false };

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
    // Nothing was submitted, so these rows are not installing: clear their
    // busy state rather than leaving them stuck on "Installing…".
    for (const id of entityIds) state.pendingActions.delete(`install:${id}`);
    render();
    loadActionItems();
    outcome.submitFailed = true;
    return outcome;
  }

  // job_ids comes back in the same order entityIds was submitted in.
  const jobs = jobIds.map((jobId, i) => ({ jobId, entityId: entityIds[i], done: false }));
  const { errors, timedOut, needsStackRestart, selfRestarted } = outcome;
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
      if (s.status === "succeeded") {
        if (s.needs_stack_restart) needsStackRestart.push(job.entityId);
      } else if (s.status === "timed_out") {
        timedOut.push(job.entityId);
      } else if (isSidecarOwnUpdate(job.entityId) && s.status === "unknown") {
        // Expected: see installResultFromJob. Not an error.
        selfRestarted.push(job.entityId);
      } else {
        errors.push(job.entityId);
      }
      // Record the outcome BEFORE clearing the busy state, so the row goes
      // straight from "Installing…" to its result. Clearing the busy state
      // first and redrawing from the last fetched data is what used to
      // flip the row back to "Install" until the next poll. The fetch
      // right after is what lets an installed row drop out as soon as the
      // server stops listing it.
      const result = installResultFromJob(s, job.entityId);
      state.installResults.set(job.entityId, result);
      state.pendingActions.delete(`install:${job.entityId}`);
      render();
      loadActionItems();
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
    state.installResults.set(job.entityId, {
      kind: "timed_out",
      message: "Still running after 20 minutes — outcome unknown, check before retrying",
      detail: "",
      at: Date.now(),
    });
    state.pendingActions.delete(`install:${job.entityId}`);
    timedOut.push(job.entityId);
  }

  return outcome;
}

async function installUpdates(entityIds) {
  // An update the integration flags `confirming` is already being applied:
  // installing it again would recreate the container a second time.
  const confirmingIds = new Set(
    (state.data.updates.items || []).filter((i) => i.confirming).map((i) => i.entity)
  );
  entityIds = entityIds.filter((id) => !confirmingIds.has(id));
  if (entityIds.length === 0) return;
  const groups = installGroups(entityIds);
  const ordered = groups.flat();
  for (const id of ordered) state.installResults.delete(id);
  showToast(`Installing ${ordered.length} update(s)…`);

  const errors = [];
  const timedOut = [];
  const needsStackRestart = [];
  const selfRestarted = [];
  let submitFailed = false;
  for (const [n, group] of groups.entries()) {
    if (n > 0) {
      showToast(
        group.length === 1 && isHomeAssistantOwnUpdate(group[0])
          ? "Everything else is done — installing Home Assistant last…"
          : `Installing ${group.length} more update(s)…`,
      );
    }
    const outcome = await runInstallGroup(group);
    errors.push(...outcome.errors);
    timedOut.push(...outcome.timedOut);
    needsStackRestart.push(...outcome.needsStackRestart);
    selfRestarted.push(...outcome.selfRestarted);
    if (outcome.submitFailed) submitFailed = true;
  }

  // A group that failed to submit has already toasted that; don't overwrite
  // it with a misleading "Installed N" summary.
  if (submitFailed && errors.length === 0 && timedOut.length === 0) {
    loadActionItems();
    return;
  }
  if (errors.length > 0 || timedOut.length > 0) {
    const parts = [];
    if (errors.length > 0) parts.push(`${errors.length} error(s)`);
    if (timedOut.length > 0) parts.push(`${timedOut.length} timed out`);
    showToast(`Done with ${parts.join(", ")} — check backend logs`);
  } else if (selfRestarted.length > 0) {
    showToast(
      ordered.length > selfRestarted.length
        ? `Installed ${ordered.length - selfRestarted.length} update(s); this app restarted to apply its own update, as expected`
        : "This app restarted to apply its own update, as expected",
    );
  } else if (needsStackRestart.length > 0) {
    // (1.3.0) No persistent banner -- a one-time toast pointing at the
    // Trouble tab, which is where the actual remediation now lives (see
    // renderTroubleRows above). Trouble picks this up on its own next
    // poll without anything special needed here.
    showToast(`Installed ${ordered.length} update(s) — a stack needs a restart, see the Needs Remediation tab`);
  } else {
    showToast(`Installed ${ordered.length} update(s)`);
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

// Dismiss is optimistic: the only thing it changes is whether the row is
// listed, so the row is hidden the moment it is clicked and the request runs
// behind it. There is no "Dismissing…" state to revert, which is what made the
// button flicker back before the next refresh. `state.dismissedTrouble` keeps
// it hidden until the server stops listing it (the integration refreshes a
// moment after the request, so a poll in between can still list it); a
// failure removes the key again so the row comes back, with a toast.
async function dismissTroubleItem(dismissKey) {
  state.dismissedTrouble.set(dismissKey, Date.now());
  render();
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
  } catch (e) {
    state.dismissedTrouble.delete(dismissKey);
    render();
    showToast(`Dismiss failed — ${e.message}`);
    console.error(e);
    return;
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
    // This only means the helper container started, not that Portainer has
    // finished: the row follows the update from here (an integration that
    // tracks it reports "updating", then the row goes or comes back failed).
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

// One request per device, one at a time (like the Cleanup batch): a failure is
// that device's own, and each row has its own state. Every row in the batch
// shows "Deleting…" from the start and frees up as its own request finishes. A
// device whose delete succeeded is hidden at once and stays hidden until the
// server stops listing it (see staleView), so the list never flips back to
// active Delete buttons for devices that are already gone. A failed device keeps
// its tick, so it can be retried.
async function postDeleteStale(deviceId) {
  try {
    const res = await fetch("/api/actions/delete-stale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [deviceId] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    if (result.errors && result.errors.length > 0) throw new Error(result.errors[0].error || "delete failed");
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

async function deleteStaleDevices(deviceIds) {
  const keyOf = (id) => `delete-stale:${id}`;
  for (const id of deviceIds) state.pendingActions.add(keyOf(id));
  render();
  showToast(`Deleting ${deviceIds.length} device(s)…`);
  let failed = 0;
  for (const id of deviceIds) {
    const ok = await postDeleteStale(id);
    state.pendingActions.delete(keyOf(id));
    if (ok) {
      state.selection.stale.delete(id);
      state.deletedStale.set(id, Date.now());
    } else {
      failed++;
    }
    render();
  }
  showToast(
    failed === 0
      ? `Deleted ${deviceIds.length} device(s)`
      : `${failed} of ${deviceIds.length} delete(s) failed — see console`
  );
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
  // Awaited, so the row stays on "Pruning…" until the new numbers are in
  // (runPending frees it after this returns) instead of flashing back to an
  // active button with the old counts.
  await loadActionItems();
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
  await loadActionItems();
}

// ---- Cleanup batch (ticked rows -> one run) ----
//
// Turns the ticked rows into an ordered list of steps: endpoints in the same
// order as the table, and within one endpoint dangling -> unused -> volumes.
// Where "unused images" is ticked, "dangling images" is not run on its own: it
// is a subset, so a second pass would only repeat the same work.
function cleanupBatchPlan(ids) {
  const endpoints = new Map((state.data.cleanup.items || []).map((ep) => [ep.device_id, ep]));
  const hosts = new Map([...endpoints].map(([device, ep]) => [device, ep.host]));
  const perDevice = new Map();
  for (const id of ids) {
    const device = cleanupSelDevice(id);
    if (!hosts.has(device)) continue;
    if (cleanupActionDisabled(endpoints.get(device), cleanupSelAction(id))) continue;
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
    if (ok) {
      state.selection.cleanup.delete(cleanupSelId(s.deviceId, s.action));
      if (s.action === "unused") state.selection.cleanup.delete(cleanupSelId(s.deviceId, "dangling"));
    } else {
      failed++;
    }
    // Re-read the numbers BEFORE the row is freed. The request above returns
    // once the integration's Cleanup numbers have caught up, so this read
    // shows the result of this step. Freeing the row first (and re-reading only
    // after the last step, as this used to) put every finished row back on an
    // active Prune button with its old counts until the whole batch was done,
    // which could be minutes.
    await loadActionItems();
    state.pendingActions.delete(keyOf(s));
    render();
  }
  showToast(failed === 0 ? `Prune requested: ${steps.length} item${steps.length === 1 ? "" : "s"}` : `${failed} of ${steps.length} failed — see console`);
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
PHONE_MQ.addEventListener("change", () => render());

const initialTab = tabFromHash();
if (initialTab) activateTab(initialTab);

loadConfig();
// Having the dashboard in front of the person counts as having read Home
// Assistant's "Portainer is reporting ..." bell notification, so tell the
// backend, which dismisses that one notification (and only that one; the
// update-result and other notifications stay until the person dismisses
// them). Best effort: nothing here depends on the answer.
//
// Page load alone missed two cases: a dashboard that was already open (the
// "open dashboard" link only switches to it), and a notification that is
// raised while the dashboard sits open. So it is also sent when the page
// becomes visible or regains focus, and on every refresh while it is visible.
// A hidden page never sends it, so nobody "reads" the notification from a
// background tab.
function notifyPanelOpened() {
  if (document.visibilityState !== "visible") return;
  fetch("/api/panel-opened", { method: "POST" }).catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    notifyPanelOpened();
    loadActionItems();
  }
});
window.addEventListener("focus", notifyPanelOpened);
notifyPanelOpened();
loadActionItems();
setInterval(() => {
  notifyPanelOpened();
  loadActionItems();
}, REFRESH_MS);
