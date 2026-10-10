"""Portainer Sidecar.

A small standalone web app giving a real management UI for the action items
tracked by the Home Assistant Portainer automation set
(sensor.portainer_updates_pending, sensor.portainer_trouble,
sensor.portainer_stale_devices, sensor.portainer_cleanup). Pairs with the
"Portainer Maintenance" HA custom integration
(https://github.com/bdelima/ha-portainer-dashboard), which registers a
sidebar panel pointing at this app and creates the four sensors it reads.

Runs as its own container. Holds the HA long-lived access token
server-side only -- it is never sent to the browser -- and proxies a
handful of read/action endpoints to HA's REST API. The frontend (static/)
is a plain HTML/JS page served by this same app.

Environment variables:
    HA_BASE_URL     Optional. Home Assistant's address for this app's own
                     server-to-server REST calls, e.g. http://ojochal.lan:8123.
                     If unset, this app auto-discovers HA on startup (see
                     `_discover_ha_base_url` below) -- the expected setup is
                     this container co-located with HA on the same Docker
                     host, which is the only scenario this app supports.
    HA_PUBLIC_URL   Optional. A browser-reachable HA address used only to
                     build "open in Home Assistant" links in the UI (history
                     page, device pages) -- separate from HA_BASE_URL because
                     an auto-discovered address (a container name or an
                     internal docker-network IP) is meaningless to your
                     phone/laptop browser. If unset, those links just don't
                     render; everything else still works. If you set
                     HA_BASE_URL explicitly to something your browser can
                     also reach (e.g. https://ha.pumapants.cc), that's reused
                     here automatically -- no need to set both.
    HA_TOKEN        a Home Assistant long-lived access token (Profile ->
                     Security -> Long-Lived Access Tokens). Treat this as a
                     secret with full API access as whichever HA user created
                     it. Pass it via an env file / Docker secret (or
                     HA_TOKEN_FILE, below), never bake it into the image.
    AUTH_USERNAME,
    AUTH_PASSWORD   Optional. Sign-in for this app's own web UI. Set both, and
                     every request needs a session (see "Authentication"
                     below). The Portainer Maintenance integration's setup form
                     takes the same pair so its sidebar panel signs in by
                     itself. With neither set (and AUTH_ALLOW_ANONYMOUS unset)
                     the app is open to anyone who can reach it, as in earlier
                     versions.
    AUTH_ALLOW_ANONYMOUS
                     Optional. true: no sign-in at all, even if the pair above
                     is set. false: refuse to serve unless the pair is set.
                     Unset: open when no pair is set, sign-in required when
                     both are.
    LOG_LEVEL       Optional. DEBUG, INFO (default), WARNING or ERROR: how much
                     this app writes to its container log (see "Logging"
                     below). Passwords, the HA token, session cookies and the
                     panel token are never logged at any level.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import ipaddress
import json
import logging
import os
import re
import socket
import sys
import time
import uuid
from urllib.parse import parse_qs, urlencode
from dataclasses import dataclass, field
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

# ---------------------------------------------------------------------------
# Logging
#
# uvicorn only configures its own loggers (uvicorn, uvicorn.access,
# uvicorn.error); anything logged under another name would be dropped below
# WARNING. So this app owns a "sidecar" logger tree with its own stdout
# handler and level (LOG_LEVEL):
#
#   sidecar         startup, Home Assistant reachability, changelog lookups
#   sidecar.auth    sign-ins, failed sign-ins, rate limiting
#   sidecar.action  every action a user triggers: what, on what, the result
#                   and how long it took, with Home Assistant's own error text
#                   when it refused
#
# uvicorn's access log is separate and only says "POST /api/... 502", never
# why. These loggers are where the why goes.
#
# Never logged, at any level: passwords (submitted or configured), HA_TOKEN,
# session cookies, the ?auth= panel token, or request query strings. Anything
# a client supplies (entity ids, device ids, keys, headers) goes through _q(),
# which repr()s it so a newline in it can't forge a log line. Nothing a user
# action logs is clipped: the whole entity id list, the whole result Home
# Assistant returned and the whole error text are written, because a clipped
# line is useless for working out what a call actually did. The one exception
# is what an unauthenticated caller controls (the request path and the
# X-Forwarded-For header on the sidecar.auth lines, see _PRE_AUTH_CLIP), which
# is clipped so a stranger can't fill the log.
# ---------------------------------------------------------------------------
_LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"


def _setup_logging() -> str | None:
    """Configures the "sidecar" logger tree. Returns a message to log once the
    handler exists if LOG_LEVEL was set to something unusable."""
    raw = os.environ.get("LOG_LEVEL", "").strip()
    level = getattr(logging, raw.upper(), None) if raw else logging.INFO
    problem = None
    if not isinstance(level, int):
        problem = f"LOG_LEVEL={raw!r} is not a log level (use DEBUG, INFO, WARNING or ERROR); using INFO"
        level = logging.INFO
    root = logging.getLogger("sidecar")
    root.setLevel(level)
    if not root.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter(_LOG_FORMAT, "%Y-%m-%d %H:%M:%S"))
        root.addHandler(handler)
    root.propagate = False
    return problem


_LOG_LEVEL_PROBLEM = _setup_logging()
log = logging.getLogger("sidecar")
log_auth = logging.getLogger("sidecar.auth")
log_action = logging.getLogger("sidecar.action")


# Applied only to values an unauthenticated caller controls.
_PRE_AUTH_CLIP = 2000


def _q(value: Any, limit: int | None = None) -> str:
    """repr() of a value, safe to put in a log line (a newline in it is
    escaped, so it can't forge one). Not clipped unless a limit is given."""
    text = str(value)
    if limit is not None and len(text) > limit:
        text = text[:limit] + "..."
    return repr(text)


def _peer(request: Request) -> str:
    """Who is asking. The socket address is what uvicorn saw (behind a reverse
    proxy that is the proxy). X-Forwarded-For is added when present but is
    only a claim by whoever sent it, so it is labelled as one."""
    ip = request.client.host if request.client else "unknown"
    fwd = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return f"{ip} (X-Forwarded-For {_q(fwd, _PRE_AUTH_CLIP)})" if fwd else ip


def _reason(exc: Exception) -> str:
    """Why a Home Assistant call failed, as one short string: the HTTP status
    (or the exception type for a timeout or connection error, whose str() is
    often empty) followed by HA's own message when it gave one."""
    status = getattr(getattr(exc, "response", None), "status_code", None)
    prefix = f"HTTP {status}" if status else type(exc).__name__
    message = _ha_error_message(exc, None) if isinstance(exc, httpx.HTTPError) else str(exc)
    message = " ".join(message.split())
    return f"{prefix}: {message}" if message else prefix


def _action_ok(action: str, detail: str, started: float, extra: str = "") -> None:
    log_action.info("%s ok %s (%.1fs)%s", action, detail, time.monotonic() - started, extra)


def _action_failed(action: str, detail: str, exc: Exception, started: float) -> None:
    log_action.warning(
        "%s FAILED %s: %s (%.1fs)", action, detail, _reason(exc), time.monotonic() - started
    )


def _load_token() -> str:
    """Prefer a mounted secret file (HA_TOKEN_FILE) over a plain env var
    (HA_TOKEN), so the token doesn't need to sit in `docker inspect` output
    or a compose file. Either works."""
    token_file = os.environ.get("HA_TOKEN_FILE")
    if token_file:
        with open(token_file, encoding="utf-8") as f:
            return f.read().strip()
    return os.environ["HA_TOKEN"]


APP_VERSION = os.environ.get("APP_VERSION", "unknown")
# Baked in at build time from the VERSION file (see Dockerfile's
# ARG VERSION / ENV APP_VERSION). Without this there was no way -- not from
# `docker inspect`, not from the app itself -- to ask a *running* container
# which version it actually was; "latest" and a creation timestamp were the
# only clues available, which is not a version number.


HA_DISCOVERY_PORT = 8123
# Common container/service names for Home Assistant -- tried first via
# Docker's own embedded DNS, which resolves instantly (no network I/O) when
# this container shares a user-defined network with HA's, e.g. Bob's
# standardized `npm_proxy` network used across every stack.
_HA_HOSTNAME_CANDIDATES = ("homeassistant", "home-assistant", "hass", "ha")


def _default_gateway() -> str | None:
    """This container's default-route gateway -- on a Docker bridge network
    that's the Docker host itself, so this is how we reach HA if it's
    running directly on the host (host network mode) rather than as a
    container sharing our own bridge network. Linux-only (/proc/net/route),
    which is fine since this only ever runs inside a Linux container."""
    try:
        with open("/proc/net/route", encoding="ascii") as f:
            for line in f.readlines()[1:]:
                fields = line.split()
                if fields[1] == "00000000":  # destination 0.0.0.0 = default route
                    return socket.inet_ntoa(bytes.fromhex(fields[2])[::-1])
    except OSError:
        return None
    return None


def _own_subnet() -> ipaddress.IPv4Network | None:
    """This container's own IP, assumed /24. True for every Docker
    user-defined bridge network -- which is what every stack in this
    homelab uses (never the default /16 bridge) -- so scanning it is a
    quick ~254-address sweep, not a subnet-wide crawl."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]
        finally:
            s.close()
        return ipaddress.ip_network(f"{ip}/24", strict=False)
    except OSError:
        return None


async def _looks_like_home_assistant(client: httpx.AsyncClient, base_url: str) -> bool:
    """Fingerprint check with no credentials involved: HA serves its PWA
    manifest at /manifest.json to anyone, unauthenticated, with a
    recognizable `name`. Deliberately doesn't send HA_TOKEN during
    discovery -- we don't yet know this address is actually HA, and this
    container's LAN segment isn't a place to hand our bearer token to
    whatever happens to answer on port 8123."""
    try:
        resp = await client.get(f"{base_url}/manifest.json", timeout=1.5)
        return resp.status_code == 200 and resp.json().get("name") == "Home Assistant"
    except Exception:
        return False


async def _discover_ha_base_url() -> str:
    """Runs once at startup when HA_BASE_URL isn't set. Order: (1) common
    container names on this container's own docker network -- covers the
    normal case, HA and this app sharing a user-defined network; (2) a scan
    of this container's own /24 -- covers HA being reachable on the same
    docker network under a name we didn't guess; (3) the docker host itself
    -- covers HA running directly on the host, or in host network mode.
    Raises if none of that finds anything, so the container fails fast
    with a clear reason instead of serving with a broken backend."""
    async with httpx.AsyncClient() as client:
        for name in _HA_HOSTNAME_CANDIDATES:
            url = f"http://{name}:{HA_DISCOVERY_PORT}"
            if await _looks_like_home_assistant(client, url):
                return url

        subnet = _own_subnet()
        if subnet is not None:
            candidates = [f"http://{ip}:{HA_DISCOVERY_PORT}" for ip in subnet.hosts()]
            checks = await asyncio.gather(
                *(_looks_like_home_assistant(client, url) for url in candidates)
            )
            for url, found in zip(candidates, checks):
                if found:
                    return url

        gateway = _default_gateway()
        for host in (gateway, "host.docker.internal"):
            if not host:
                continue
            url = f"http://{host}:{HA_DISCOVERY_PORT}"
            if await _looks_like_home_assistant(client, url):
                return url

    raise RuntimeError(
        "HA_BASE_URL isn't set and auto-discovery couldn't find a Home "
        "Assistant instance on this container's docker network, its /24 "
        "subnet, or the docker host itself. Set HA_BASE_URL explicitly "
        "(e.g. http://ojochal.lan:8123) and restart."
    )


# Left unresolved until the startup handler below runs (or immediately, if
# set explicitly) -- see module docstring.
HA_BASE_URL: str | None = (os.environ.get("HA_BASE_URL") or "").rstrip("/") or None
HA_PUBLIC_URL: str | None = (os.environ.get("HA_PUBLIC_URL") or "").rstrip("/") or None
HA_TOKEN = _load_token()

HEADERS = {
    "Authorization": f"Bearer {HA_TOKEN}",
    "Content-Type": "application/json",
}

SENSORS = {
    "updates": "sensor.portainer_updates_pending",
    # (1.3.0) renamed from sensor.portainer_container_trouble on the
    # integration side when it grew to cover endpoints and stuck
    # containers, not just individual container health.
    "trouble": "sensor.portainer_trouble",
    "stale": "sensor.portainer_stale_devices",
    "cleanup": "sensor.portainer_cleanup",
}

app = FastAPI(title="Portainer Sidecar")


# ---------------------------------------------------------------------------
# Authentication
#
# Three modes, picked from the environment (see _auth_mode):
#   anonymous  No checks at all. This is the default when nothing is
#              configured, so an install keeps working exactly as it did before
#              sign-in existed, and also what AUTH_ALLOW_ANONYMOUS=true gives
#              (which wins even over a username/password pair).
#   required   AUTH_USERNAME and AUTH_PASSWORD both set. Every request except
#              /healthz, /version and /login needs a valid session cookie.
#   locked     A misconfiguration: only one of the pair set, or
#              AUTH_ALLOW_ANONYMOUS=false with no pair. Nothing is served
#              except /healthz and /version, with a message saying what to fix.
#              Better to refuse than to guess which way the owner meant it.
#
# A session is a stateless signed cookie, so there is nothing to store: it is
# "<expiry>.<HMAC>", keyed from the password, so changing the password signs
# everyone out.
#
# Two ways in, both ending in that cookie:
#   * /login, a plain username/password form (a browser opened directly).
#   * ?auth=<panel token> on any page. The Portainer Maintenance integration
#     appends this to the URL of its Home Assistant sidebar panel, because an
#     HA iframe panel can pass nothing but a URL. The token is
#     HMAC-SHA256(key=password, msg="portainer-sidecar-panel:" + username),
#     so it is not the password and cannot be turned back into it, but anyone
#     holding it can sign in. The integration computes the identical value
#     (sidecar_auth.py there); change one side and change the other.
# ---------------------------------------------------------------------------
def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


AUTH_USERNAME = os.environ.get("AUTH_USERNAME", "")
AUTH_PASSWORD = os.environ.get("AUTH_PASSWORD", "")
# None = not set (or blank), True/False = set explicitly.
AUTH_ALLOW_ANONYMOUS: bool | None = (
    _truthy(os.environ["AUTH_ALLOW_ANONYMOUS"])
    if os.environ.get("AUTH_ALLOW_ANONYMOUS", "").strip()
    else None
)

SESSION_COOKIE = "sidecar_session"
SESSION_MAX_AGE = 30 * 24 * 3600
# Probes that must keep working without a session (Docker healthcheck, version
# checks from the README).
PUBLIC_PATHS = frozenset({"/healthz", "/version"})

_LOGIN_MAX_FAILURES = 10
_LOGIN_WINDOW = 300.0
_LOGIN_FAIL_DELAY = 1.0
_LOGIN_FAILURES: dict[str, list[float]] = {}


def _auth_mode() -> str:
    if AUTH_ALLOW_ANONYMOUS:
        return "anonymous"
    if AUTH_USERNAME and AUTH_PASSWORD:
        return "required"
    if AUTH_USERNAME or AUTH_PASSWORD:
        return "locked"  # only one of the pair
    if AUTH_ALLOW_ANONYMOUS is None:
        return "anonymous"  # nothing configured: open, as before sign-in existed
    return "locked"  # AUTH_ALLOW_ANONYMOUS=false but no credentials to require


def _locked_message() -> str:
    if bool(AUTH_USERNAME) != bool(AUTH_PASSWORD):
        return (
            "Authentication is half configured: AUTH_USERNAME and AUTH_PASSWORD "
            "must both be set."
        )
    return (
        "AUTH_ALLOW_ANONYMOUS is false but no sign-in is configured. Set "
        "AUTH_USERNAME and AUTH_PASSWORD in this container's environment, or "
        "remove AUTH_ALLOW_ANONYMOUS (or set it to true) to allow "
        "unauthenticated access, then restart it."
    )


def panel_token(username: str, password: str) -> str:
    """The value the integration appends to the sidebar panel URL as ?auth=."""
    return hmac.new(
        password.encode("utf-8"),
        b"portainer-sidecar-panel:" + username.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _session_sig(exp: int) -> str:
    key = hashlib.sha256(b"portainer-sidecar-session:" + AUTH_PASSWORD.encode("utf-8")).digest()
    return hmac.new(key, f"{AUTH_USERNAME}:{exp}".encode("utf-8"), hashlib.sha256).hexdigest()


def _make_session() -> str:
    exp = int(time.time()) + SESSION_MAX_AGE
    return f"{exp}.{_session_sig(exp)}"


def _session_valid(value: str) -> bool:
    try:
        exp_text, sig = value.split(".", 1)
        exp = int(exp_text)
    except ValueError:
        return False
    if exp < time.time():
        return False
    return hmac.compare_digest(sig.encode("utf-8"), _session_sig(exp).encode("utf-8"))


def _credentials_ok(username: str, password: str) -> bool:
    # Both comparisons always run, so timing does not reveal which was wrong.
    user_ok = hmac.compare_digest(username.encode("utf-8"), AUTH_USERNAME.encode("utf-8"))
    pass_ok = hmac.compare_digest(password.encode("utf-8"), AUTH_PASSWORD.encode("utf-8"))
    return user_ok and pass_ok


def _safe_next(value: str | None) -> str:
    """Only a same-site path may be redirected to after sign-in."""
    if (
        not value
        or not value.startswith("/")
        or value.startswith("//")
        or "\\" in value
        or any(ord(c) < 32 for c in value)
    ):
        return "/"
    return value


def _set_session_cookie(response: Any, request: Request) -> None:
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    secure = proto == "https" or request.url.scheme == "https"
    # SameSite=Lax: the cookie is not sent on cross-site POSTs, so another
    # website cannot drive the action endpoints with it. It does travel inside
    # the Home Assistant iframe as long as HA and this app are on the same
    # site (for example ha.example.com and sidecar.example.com).
    response.set_cookie(
        SESSION_COOKIE,
        _make_session(),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/",
    )


def _recent_failures(ip: str) -> list[float]:
    now = time.time()
    recent = [t for t in _LOGIN_FAILURES.get(ip, []) if now - t < _LOGIN_WINDOW]
    if recent:
        _LOGIN_FAILURES[ip] = recent
    else:
        _LOGIN_FAILURES.pop(ip, None)
    return recent


def _record_failure(ip: str) -> None:
    if len(_LOGIN_FAILURES) > 1000:
        _LOGIN_FAILURES.clear()
    _LOGIN_FAILURES.setdefault(ip, []).append(time.time())


_PAGE_STYLE = (
    "body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;"
    "align-items:center;justify-content:center;background:#f4f5f7;color:#1b1f24}"
    "form,.box{background:#fff;padding:24px;border-radius:10px;width:min(320px,90vw);"
    "box-shadow:0 1px 6px rgba(0,0,0,.15)}"
    "h1{font-size:18px;margin:0 0 16px}label{display:block;font-size:13px;margin:12px 0 4px}"
    "input{width:100%;box-sizing:border-box;padding:8px;font-size:15px;border:1px solid #9aa4af;"
    "border-radius:6px;background:#fff;color:inherit}"
    "button{margin-top:18px;width:100%;padding:9px;font-size:15px;border:0;border-radius:6px;"
    "background:#1b6ef3;color:#fff;cursor:pointer}.err{color:#c62828;font-size:13px;margin-top:12px}"
    "@media(prefers-color-scheme:dark){body{background:#111418;color:#e6e9ed}"
    "form,.box{background:#1c2026}input{background:#111418;border-color:#4a5360}}"
)


def _login_html(next_path: str, error: str = "") -> str:
    err = f'<div class="err">{html.escape(error)}</div>' if error else ""
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>Portainer Sidecar: sign in</title><style>{_PAGE_STYLE}</style></head><body>"
        '<form method="post" action="/login"><h1>Portainer Sidecar</h1>'
        f'<input type="hidden" id="next" name="next" value="{html.escape(next_path, quote=True)}">'
        '<label for="u">Username</label>'
        '<input id="u" name="username" autocomplete="username" autofocus required>'
        '<label for="p">Password</label>'
        '<input id="p" name="password" type="password" autocomplete="current-password" required>'
        f'<button type="submit">Sign in</button>{err}</form>'
        # A #fragment on the original link (a notification deep link such as
        # #needs-remediation) survives the redirect to this page but not the
        # form post, so it is added back to the target here.
        "<script>var n=document.getElementById('next');"
        "if(location.hash&&n.value.indexOf('#')<0)n.value+=location.hash;</script>"
        "</body></html>"
    )


def _locked_response(request: Request) -> Any:
    message = _locked_message()
    if request.url.path.startswith("/api/"):
        return JSONResponse({"detail": message}, status_code=503)
    return HTMLResponse(
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>Portainer Sidecar</title><style>{_PAGE_STYLE}</style></head><body>"
        f'<div class="box"><h1>Portainer Sidecar</h1><p>{html.escape(message)}</p></div></body></html>',
        status_code=503,
    )


@app.middleware("http")
async def _auth_gate(request: Request, call_next):
    """Defined before _no_cache so that one wraps this: sign-in redirects and
    401s are marked no-store too."""
    path = request.url.path
    if path in PUBLIC_PATHS:
        return await call_next(request)
    mode = _auth_mode()
    if mode == "anonymous":
        if path == "/login":
            return RedirectResponse("/", status_code=303)
        return await call_next(request)
    if mode == "locked":
        return _locked_response(request)
    if path == "/login":
        return await call_next(request)
    if _session_valid(request.cookies.get(SESSION_COOKIE, "")):
        return await call_next(request)
    token = request.query_params.get("auth")
    if (
        request.method == "GET"
        and token
        and hmac.compare_digest(token.encode("utf-8"), panel_token(AUTH_USERNAME, AUTH_PASSWORD).encode("utf-8"))
    ):
        rest = [(k, v) for k, v in request.query_params.multi_items() if k != "auth"]
        target = path + ("?" + urlencode(rest) if rest else "")
        response = RedirectResponse(target, status_code=303)
        _set_session_cookie(response, request)
        log_auth.info("signed in with the panel token from %s", _peer(request))
        return response
    if token:
        # A panel token was presented and it was wrong (most often a stale
        # link after the password changed). The token itself is not logged.
        log_auth.warning("rejected a wrong panel token on %s %s from %s", request.method, _q(path, _PRE_AUTH_CLIP), _peer(request))
    if path.startswith("/api/"):
        # DEBUG, not WARNING: a browser tab left open after its session
        # expired polls /api/action-items every 15 seconds, and uvicorn's
        # access log already shows each 401.
        log_auth.debug("unauthenticated %s %s from %s", request.method, _q(path, _PRE_AUTH_CLIP), _peer(request))
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    target = path + ("?" + request.url.query if request.url.query else "")
    return RedirectResponse("/login?" + urlencode({"next": target}), status_code=303)


@app.on_event("startup")
async def _log_auth_mode() -> None:
    log.info(
        "Portainer Sidecar %s starting (log level %s)",
        APP_VERSION,
        logging.getLevelName(log.getEffectiveLevel()),
    )
    if _LOG_LEVEL_PROBLEM:
        log.warning(_LOG_LEVEL_PROBLEM)
    mode = _auth_mode()
    if mode == "anonymous" and AUTH_ALLOW_ANONYMOUS:
        log_auth.warning("AUTH_ALLOW_ANONYMOUS is true: this app is serving WITHOUT authentication")
    elif mode == "anonymous":
        log_auth.warning(
            "No sign-in configured: this app is serving WITHOUT authentication. "
            "Set AUTH_USERNAME and AUTH_PASSWORD to require one."
        )
    elif mode == "locked":
        log_auth.error("%s Serving only /healthz and /version.", _locked_message())
    else:
        log_auth.info("Authentication required (user %s)", _q(AUTH_USERNAME))


@app.get("/login", response_class=HTMLResponse)
async def login_page(next: str = "/") -> HTMLResponse:
    return HTMLResponse(_login_html(_safe_next(next)))


@app.post("/login")
async def login_submit(request: Request) -> Any:
    ip = request.client.host if request.client else "unknown"
    if len(_recent_failures(ip)) >= _LOGIN_MAX_FAILURES:
        log_auth.warning(
            "sign-in blocked: %d failed attempts from %s in the last %d s",
            _LOGIN_MAX_FAILURES,
            _peer(request),
            int(_LOGIN_WINDOW),
        )
        return HTMLResponse(_login_html("/", "Too many failed attempts. Try again in a few minutes."), status_code=429)
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > 4096:
            log_auth.warning("sign-in form from %s rejected: body over 4096 bytes", _peer(request))
            raise HTTPException(status_code=413, detail="Request too large")
    form = parse_qs(body.decode("utf-8", "replace"))
    username = form.get("username", [""])[0]
    password = form.get("password", [""])[0]
    next_path = _safe_next(form.get("next", ["/"])[0])
    if _credentials_ok(username, password):
        _LOGIN_FAILURES.pop(ip, None)
        response = RedirectResponse(next_path, status_code=303)
        _set_session_cookie(response, request)
        log_auth.info("signed in with username and password from %s", _peer(request))
        return response
    _record_failure(ip)
    # The attempted username is deliberately not logged: people paste the
    # password into the wrong box, and it would end up here.
    log_auth.warning(
        "failed sign-in from %s (%d of %d allowed in %d s)",
        _peer(request),
        len(_recent_failures(ip)),
        _LOGIN_MAX_FAILURES,
        int(_LOGIN_WINDOW),
    )
    await asyncio.sleep(_LOGIN_FAIL_DELAY)
    return HTMLResponse(_login_html(next_path, "Wrong username or password."), status_code=401)


@app.middleware("http")
async def _no_cache(request: Request, call_next):
    """Every response from this app, static assets included, is explicitly
    marked never to be cached.

    Starlette's StaticFiles (what serves static/index.html, app.js,
    style.css below) sets no Cache-Control header of its own -- with none
    present, browsers fall back to *heuristic* caching, guessing a freshness
    lifetime from the file's Last-Modified age and sometimes serving a
    cached copy straight out of disk cache without ever asking the server
    again. This bit in production (1.2.2): after a real image update that
    changed index.html's heading, a browser viewing this app through Home
    Assistant's iframe panel kept showing the old heading through repeated
    reloads (even a hard reload) -- only explicitly disabling the browser
    cache in devtools forced a real request. An iframe's subresource fetches
    don't reliably get the same "bypass cache" treatment a top-level hard
    reload gives the page you're actually looking at, so relying on the user
    to know to hard-refresh (or disable cache) isn't a fix, it's a workaround.
    This app is small and low-traffic -- there's no real cost to just never
    caching anything, so `no-store` on every response removes the whole
    class of "why does this still look old" confusion for good, in the
    browser tab, the HA iframe, or anywhere else this gets embedded."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.on_event("startup")
async def _ensure_ha_base_url() -> None:
    global HA_BASE_URL, HA_PUBLIC_URL
    if HA_BASE_URL is None:
        HA_BASE_URL = await _discover_ha_base_url()
        log.info("HA_BASE_URL not set -- auto-discovered Home Assistant at %s", HA_BASE_URL)
    else:
        log.info("Using Home Assistant at %s (HA_BASE_URL)", HA_BASE_URL)
    if HA_PUBLIC_URL is None and os.environ.get("HA_BASE_URL"):
        # Only reuse HA_BASE_URL for browser links if the user set it
        # explicitly -- an auto-discovered address (container name or
        # internal docker IP) is meaningless to a phone/laptop browser, so
        # it's never used here even though it's sitting right above.
        HA_PUBLIC_URL = HA_BASE_URL


async def ha_get_state(entity_id: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{HA_BASE_URL}/api/states/{entity_id}", headers=HEADERS)
        if resp.status_code == 404:
            # Sensor not created yet (e.g. hasn't fired its first trigger) --
            # treat as "nothing to report" rather than erroring the whole page.
            return {"state": "0", "attributes": {"items": []}}
        resp.raise_for_status()
        return resp.json()


async def ha_call_service(domain: str, service: str, data: dict[str, Any], timeout: float = 30) -> None:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{HA_BASE_URL}/api/services/{domain}/{service}", headers=HEADERS, json=data
        )
        resp.raise_for_status()


async def ha_call_service_with_response(
    domain: str, service: str, data: dict[str, Any], timeout: float = 180
) -> dict[str, Any]:
    """Same as ha_call_service, but for a service registered with
    supports_response (perform_update below) -- the ?return_response query
    param is what makes HA's REST API include service_response in the body
    at all; a service that doesn't support it (or a caller that forgets
    the query param on one that does) gets a 400, per HA's own REST API
    docs. Returns the raw service_response dict -- perform_update's shape
    is {"needs_stack_restart": bool, "stack_switch_entity_id": str|None},
    not the per-entity-keyed shape HA uses for target-based services, since
    this one isn't called with a target/entity_id selector.

    180s timeout, not the 30s every other call here uses: as of the
    integration's stack-restart-needed detection rewrite, perform_update
    can itself block for up to 150s on a container that's part of a stack
    (it watches the container's actual image reference across at least
    two of core's own 60s Portainer-poll cycles before concluding a
    recreate genuinely failed, rather than trusting HA core's own
    generic-wrapped exception text -- see the integration's
    _await_recreate_outcome for why). A shorter client timeout here would
    surface a false timeout error to the user while the backend was still
    correctly working it out.

    `timeout` overrides that 180s default for a caller whose backend
    legitimately takes longer (update_portainer below waits on an image
    pull of up to 5 minutes)."""
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{HA_BASE_URL}/api/services/{domain}/{service}?return_response",
            headers=HEADERS,
            json=data,
        )
        resp.raise_for_status()
        return resp.json().get("service_response", {})


@app.get("/api/config")
async def get_config() -> dict[str, str]:
    # Deliberately HA_PUBLIC_URL here, not HA_BASE_URL -- see module
    # docstring. Neither is sensitive (unlike HA_TOKEN); the frontend uses
    # this to build "open in Home Assistant" links for device/history pages.
    return {"ha_base_url": HA_PUBLIC_URL or ""}


# The bell notification the Portainer Maintenance blueprint keeps up to date
# ("Portainer is reporting 6 image updates ... Open dashboard to review"). The
# id is fixed in the integration's bundled blueprint
# (bundled_blueprints/automation/portainer_automations.yaml, the last step).
ACTION_ITEMS_NOTIFICATION_ID = "portainer_maintenance_action_items"


@app.post("/api/panel-opened")
async def panel_opened() -> dict[str, bool]:
    """Called once when the dashboard page loads. Opening the dashboard counts
    as having read that notification, and a link in a notification cannot run
    anything itself, so this dismisses it. Best effort: if Home Assistant
    can't be reached, or the notification isn't there, nothing happens. The
    blueprint re-creates it the next time it runs and anything is still
    pending."""
    try:
        await ha_call_service(
            "persistent_notification",
            "dismiss",
            {"notification_id": ACTION_ITEMS_NOTIFICATION_ID},
            timeout=10,
        )
    except httpx.HTTPError as exc:
        # Best effort by design, and it runs on every page load, so DEBUG.
        log_action.debug("panel-opened: could not dismiss the bell notification: %s", _reason(exc))
    return {"ok": True}


# ---------------------------------------------------------------------
# Dashboard compatibility (the "Update dashboard" row on Needs Remediation)
#
# This app leans on the Portainer Maintenance integration in Home Assistant:
# its services, the fields on its sensors, the behavior built on them. The
# integration reports an API LEVEL (major.minor.patch, an attribute of
# sensor.portainer_actions_url, next to `version`, the release Home Assistant
# is running). It is not the release number: it only changes when something
# this app relies on changes. REQUIRED_DASHBOARD_API_LEVEL is the lowest level
# this app can work with -- raise it, in the same change, whenever this app
# starts to rely on something newer in the integration.
#
# An integration that predates the attribute has none, which counts as too old.
# While the running level is too low there is one extra Needs Remediation row,
# built here (the integration cannot raise it: the old one does not know what
# this app needs). It drives the fix through Home Assistant's own services:
#   update.install on the integration's HACS update entity, then a confirmed
#   homeassistant.restart. HACS downloads the new files but Home Assistant keeps
#   running the old code until it restarts.
# ---------------------------------------------------------------------
REQUIRED_DASHBOARD_API_LEVEL = "1.0.0"
DASHBOARD_INFO_ENTITY = "sensor.portainer_actions_url"
DASHBOARD_REPO = "bdelima/ha-portainer-dashboard"
# Normally found by looking for the HACS update entity of DASHBOARD_REPO; set
# this (e.g. update.portainer_maintenance_update) to name it explicitly.
DASHBOARD_UPDATE_ENTITY_OVERRIDE = (os.environ.get("DASHBOARD_UPDATE_ENTITY") or "").strip() or None
_dashboard_update_entity: str | None = None


def _parse_level(value: Any) -> tuple[int, int, int] | None:
    """"1.2.3" -> (1, 2, 3); None for anything that is not major.minor.patch."""
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"\s*v?(\d+)\.(\d+)\.(\d+)\s*", value)
    return (int(match[1]), int(match[2]), int(match[3])) if match else None


def _norm_version(value: Any) -> str:
    """A release number without whitespace or a leading "v", for comparing the
    version HACS has installed with the one Home Assistant is running."""
    return str(value or "").strip().lstrip("vV")


async def _ha_state_or_none(entity_id: str) -> dict[str, Any] | None:
    """The entity's state, or None when Home Assistant does not have it (404).
    Unlike ha_get_state, which fakes an empty sensor for a missing one."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{HA_BASE_URL}/api/states/{entity_id}", headers=HEADERS)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()


async def _find_dashboard_update_entity() -> str | None:
    """The HACS update entity of the dashboard integration. HACS gives each
    repository it manages an update.* entity whose release_url points at the
    repository (and, for an integration, whose picture is the integration's
    brand icon), so that is what is looked for. Only searched for while a row
    is needed; the answer is remembered until the entity goes missing."""
    global _dashboard_update_entity
    if DASHBOARD_UPDATE_ENTITY_OVERRIDE:
        return DASHBOARD_UPDATE_ENTITY_OVERRIDE
    if _dashboard_update_entity:
        if await _ha_state_or_none(_dashboard_update_entity) is not None:
            return _dashboard_update_entity
        _dashboard_update_entity = None
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(f"{HA_BASE_URL}/api/states", headers=HEADERS)
        resp.raise_for_status()
        for entry in resp.json():
            entity_id = str(entry.get("entity_id", ""))
            if not entity_id.startswith("update."):
                continue
            attrs = entry.get("attributes") or {}
            release_url = str(attrs.get("release_url") or "").lower()
            picture = str(attrs.get("entity_picture") or "").lower()
            if f"github.com/{DASHBOARD_REPO}".lower() in release_url or "/_/portainer_maintenance/" in picture:
                _dashboard_update_entity = entity_id
                log.info("Found the dashboard integration's HACS update entity: %s", entity_id)
                return entity_id
    return None


# ---------------------------------------------------------------------
# Getting the dashboard update on demand
#
# HACS looks for new releases on its own schedule, which it does not document
# and which can be hours, and it has no service to ask it to look sooner. So
# when the row is needed but HACS says there is nothing newer, two steps run,
# in this order, each failing soft (a failure is logged and the next step, or
# the row as it was, carries on):
#   1. Ask HACS to re-check just the dashboard repository: the websocket
#      command its own "Update information" menu item sends
#      (hacs/repository/refresh). It is HACS's frontend command, not a
#      documented API, and it needs an administrator's token. HACS identifies a
#      repository by an internal id, found once through hacs/repositories/list.
#   2. If HACS still shows nothing newer, look at the dashboard's newest GitHub
#      release. A newer one than HACS has downloaded is offered anyway, and
#      installed through update.install with an explicit version, which the
#      HACS update entity supports. That path does not depend on HACS's own
#      release data at all.
# Step 1 is throttled (HACS_REFRESH_COOLDOWN_SECONDS) so the page's 15-second
# polls do not turn into a GitHub request storm; step 2 is cached.
# ---------------------------------------------------------------------
HACS_REFRESH_COOLDOWN_SECONDS = 600
DASHBOARD_RELEASE_TTL_SECONDS = 300
_hacs_repo_id: str | None = None
_hacs_refresh_at: float | None = None
_hacs_refresh_lock = asyncio.Lock()
_dashboard_release: tuple[float, str | None] | None = None
_last_dashboard_decision: tuple[str, str] | None = None


async def _ha_ws_session(work: Any, timeout: float = 20) -> Any:
    """Opens Home Assistant's websocket API, signs in with the token and runs
    `await work(call)`, where `await call(command)` sends one command and
    returns its "result" message. Raises on any failure (the caller decides what
    that means); the whole session is capped at `timeout` seconds."""
    # Installed with uvicorn[standard]; imported here so that a missing or
    # incompatible one only costs this feature, never the app starting.
    from websockets.asyncio.client import connect

    url = f"{str(HA_BASE_URL).replace('http', 'ws', 1)}/api/websocket"

    async def run() -> Any:
        async with connect(url, max_size=32 * 1024 * 1024, open_timeout=10) as ws:
            greeting = json.loads(await ws.recv())
            if greeting.get("type") != "auth_required":
                raise RuntimeError(f"unexpected greeting from Home Assistant's websocket: {greeting.get('type')!r}")
            await ws.send(json.dumps({"type": "auth", "access_token": HA_TOKEN}))
            reply = json.loads(await ws.recv())
            if reply.get("type") != "auth_ok":
                raise RuntimeError("Home Assistant's websocket did not accept the token")
            next_id = 0

            async def call(command: dict[str, Any]) -> dict[str, Any]:
                nonlocal next_id
                next_id += 1
                await ws.send(json.dumps({**command, "id": next_id}))
                while True:
                    message = json.loads(await ws.recv())
                    if message.get("type") == "result" and message.get("id") == next_id:
                        return message

            return await work(call)

    return await asyncio.wait_for(run(), timeout)


def _ws_error(message: dict[str, Any]) -> str:
    error = message.get("error") or {}
    return f"{error.get('code', 'error')}: {error.get('message', 'no message')}"


async def _refresh_hacs_dashboard_repo() -> bool:
    """Step 1: asks HACS to re-check the dashboard repository (and only that
    one). True when HACS did it; False when it was skipped (asked within the
    last HACS_REFRESH_COOLDOWN_SECONDS, whether or not that worked) or failed."""
    global _hacs_repo_id, _hacs_refresh_at
    async with _hacs_refresh_lock:
        now = time.monotonic()
        if _hacs_refresh_at is not None and now - _hacs_refresh_at < HACS_REFRESH_COOLDOWN_SECONDS:
            return False
        _hacs_refresh_at = now

        async def work(call: Any) -> str:
            global _hacs_repo_id
            if _hacs_repo_id is None:
                listed = await call({"type": "hacs/repositories/list", "categories": ["integration"]})
                if not listed.get("success"):
                    raise RuntimeError(f"HACS would not list its repositories ({_ws_error(listed)})")
                for repo in listed.get("result") or []:
                    if str(repo.get("full_name", "")).lower() == DASHBOARD_REPO.lower():
                        _hacs_repo_id = str(repo.get("id"))
                        break
                if _hacs_repo_id is None:
                    raise RuntimeError(f"HACS does not list {DASHBOARD_REPO}")
            refreshed = await call({"type": "hacs/repository/refresh", "repository": _hacs_repo_id})
            if not refreshed.get("success"):
                _hacs_repo_id = None  # may be stale; looked up again next time
                raise RuntimeError(f"HACS refused the re-check ({_ws_error(refreshed)})")
            return _hacs_repo_id

        started = time.monotonic()
        try:
            repo_id = await _ha_ws_session(work)
        except Exception as exc:  # noqa: BLE001 -- this must never break the page, whatever goes wrong
            log_action.warning(
                "dashboard: asking HACS to re-check %s failed: %s (%.1fs); falling back to the GitHub release",
                DASHBOARD_REPO, _reason(exc), time.monotonic() - started,
            )
            return False
        log_action.info(
            "dashboard: asked HACS to re-check %s (repository id %s) (%.1fs)",
            DASHBOARD_REPO, _q(repo_id), time.monotonic() - started,
        )
        return True


async def _latest_dashboard_release_tag() -> str | None:
    """Step 2's lookup: the tag of the dashboard's newest GitHub release (not a
    pre-release, and only if it is a plain major.minor.patch tag), or None.
    Cached for DASHBOARD_RELEASE_TTL_SECONDS, failures included."""
    global _dashboard_release
    now = time.monotonic()
    if _dashboard_release is not None and now - _dashboard_release[0] < DASHBOARD_RELEASE_TTL_SECONDS:
        return _dashboard_release[1]
    tag: str | None = None
    try:
        release = await _fetch_github_release(DASHBOARD_REPO)
        if release and not release.get("prerelease") and _parse_level(release.get("tag_name")) is not None:
            tag = str(release["tag_name"])
    except httpx.HTTPError as exc:
        log.warning("Latest %s release lookup failed: %s", DASHBOARD_REPO, _reason(exc))
    _dashboard_release = (now, tag)
    return tag


def _log_dashboard_decision(via: str, version: str) -> None:
    """Says once per change which route found the update, so the log shows
    which of the two steps worked."""
    global _last_dashboard_decision
    if _last_dashboard_decision == (via, version):
        return
    _last_dashboard_decision = (via, version)
    if via == "github":
        log_action.info(
            "dashboard: %s is released on GitHub but HACS still shows nothing newer; "
            "it will be installed by explicit version", _q(version),
        )
    else:
        log_action.info("dashboard: HACS offers %s", _q(version))


def _dashboard_row(phase: str, running_level: str | None, running_version: str | None, installed: str,
                   latest: str, entity: str | None, via: str = "hacs",
                   install_version: str | None = None) -> dict[str, Any]:
    """The Needs Remediation row for an integration that is too old. `phase`
    says where things stand and `action` which button (if any) the row gets:
    "update" (download it through HACS) or "restart" (Home Assistant restart).
    `via` is "github" when the update was found on GitHub rather than offered
    by HACS; `install_version` is then the release tag update.install is given."""
    required = REQUIRED_DASHBOARD_API_LEVEL
    reports = f"API level {running_level}" if running_level else "no API level (an older release)"
    need = f"This sidecar needs the Portainer Maintenance integration at API level {required} or later; the one running in Home Assistant reports {reports}."
    if phase == "update_available":
        if via == "github":
            secondary = f"Version {latest} is released on GitHub (HACS has not picked it up yet). Update it, then restart Home Assistant."
        else:
            secondary = f"Version {latest} is available in HACS. Update it, then restart Home Assistant."
        action = "update"
    elif phase == "installing":
        secondary = "Downloading the new version through HACS…"
        action = None
    elif phase == "restart_needed":
        secondary = f"Version {installed} is downloaded. Restart Home Assistant to finish."
        action = "restart"
    elif phase == "restart_or_unpublished":
        secondary = ("If you have already updated the integration in HACS, restart Home Assistant to finish. "
                     "Otherwise a newer integration release is needed.")
        action = "restart"
    elif phase == "no_release":
        secondary = f"HACS has no newer release of the integration (running {running_version}). A new release is needed."
        action = None
    else:  # no_hacs
        secondary = "The integration's HACS update entity was not found. Update it in HACS (or by hand) and restart Home Assistant."
        action = None
    detail = (
        f"{need} Until it is updated, some actions here may fail or be missing. "
        "Updating this sidecar is always safe on its own; it is the integration that has to catch up. "
        "Two steps: Update dashboard downloads the new integration through HACS, then Restart HA "
        "(it asks first) restarts Home Assistant, because HACS only downloads the files and Home "
        "Assistant keeps running the old code until it restarts. This row goes away once Home "
        "Assistant is running an integration that reports the needed API level."
    )
    return {
        "kind": "dashboard_update",
        "name": "Dashboard integration needs an update",
        "secondary_info": secondary,
        "detail": detail,
        "phase": phase,
        "action": action,
        "update_entity": entity,
        "via": via,
        "install_version": install_version,
        "required_api_level": required,
        "running_api_level": running_level,
        "running_version": running_version,
        "installed_version": installed or None,
        "latest_version": latest or None,
    }


async def dashboard_compat() -> dict[str, Any] | None:
    """None when the running integration meets REQUIRED_DASHBOARD_API_LEVEL
    (or is not reporting yet), otherwise the row to show. Best effort: a Home
    Assistant that cannot be asked gives None rather than a false row."""
    info = await _ha_state_or_none(DASHBOARD_INFO_ENTITY)
    if info is None or str(info.get("state")) in ("unavailable", "unknown"):
        # Not there yet (Home Assistant is still starting): nothing to judge.
        return None
    attrs = info.get("attributes") or {}
    required = _parse_level(REQUIRED_DASHBOARD_API_LEVEL)
    running = _parse_level(attrs.get("api_level"))
    if required is not None and running is not None and running >= required:
        return None
    running_level = attrs.get("api_level") if running is not None else None
    running_version = _norm_version(attrs.get("version")) or None

    entity = await _find_dashboard_update_entity()
    hacs = await _ha_state_or_none(entity) if entity else None
    if hacs is None or str(hacs.get("state")) in ("unavailable", "unknown"):
        return _dashboard_row("no_hacs", running_level, running_version, "", "", entity)
    hattrs = hacs.get("attributes") or {}
    installed = _norm_version(hattrs.get("installed_version"))
    latest = _norm_version(hattrs.get("latest_version"))
    via = "hacs"
    install_version: str | None = None
    if not hattrs.get("in_progress") and str(hacs.get("state")) != "on":
        # HACS shows nothing newer, which may only mean it has not looked yet.
        # Step 1: ask it to re-check our repository, then read its answer again.
        if await _refresh_hacs_dashboard_repo():
            hacs = await _ha_state_or_none(entity) or hacs
            hattrs = hacs.get("attributes") or {}
            installed = _norm_version(hattrs.get("installed_version"))
            latest = _norm_version(hattrs.get("latest_version"))
        # Step 2: still nothing? Compare with the newest GitHub release.
        if str(hacs.get("state")) != "on":
            tag = await _latest_dashboard_release_tag()
            current = _parse_level(installed) or _parse_level(running_version)
            newest = _parse_level(tag)
            if tag and newest and current and newest > current:
                via, install_version, latest = "github", tag, _norm_version(tag)
    if hattrs.get("in_progress"):
        phase = "installing"
    elif str(hacs.get("state")) == "on" or via == "github":
        phase = "update_available"
        _log_dashboard_decision(via, latest)
    elif running_version:
        # The integration reports its running release: downloaded but not yet
        # running is exactly "HACS has a different version than Home
        # Assistant runs".
        phase = "restart_needed" if running_version != installed else "no_release"
    else:
        # An integration too old to report its release: "downloaded, restart
        # pending" cannot be told apart from "no newer release", so offer the
        # restart with text that covers both.
        phase = "restart_or_unpublished"
    return _dashboard_row(phase, running_level, running_version, installed, latest, entity, via, install_version)


@app.post("/api/actions/update-dashboard")
async def update_dashboard() -> dict[str, Any]:
    """Downloads the newer dashboard integration through HACS (update.install
    on its HACS update entity). Home Assistant keeps running the old code until
    it restarts. Refused unless the row is currently offering this."""
    started = time.monotonic()
    row = await dashboard_compat()
    if row is None or row["action"] != "update" or not row["update_entity"]:
        raise HTTPException(status_code=409, detail="The dashboard integration does not need downloading right now")
    entity = row["update_entity"]
    detail = _q(entity)
    data: dict[str, Any] = {"entity_id": entity}
    how = ""
    if row.get("install_version"):
        # Found on GitHub, not offered by HACS: name the version so HACS
        # downloads it without needing to have noticed it.
        data["version"] = row["install_version"]
        how = " (explicit version, from the GitHub release)"
    try:
        await ha_call_service("update", "install", data, timeout=180)
        _action_ok("update_dashboard", detail, started, f": {_q(row['latest_version'])}{how}")
    except httpx.HTTPError as exc:
        _action_failed("update_dashboard", detail, exc, started)
        raise HTTPException(status_code=502, detail=f"update failed: {_ha_error_message(exc)}") from exc
    return {"ok": True}


@app.post("/api/actions/restart-ha")
async def restart_home_assistant() -> dict[str, Any]:
    """Restarts Home Assistant so it runs the downloaded dashboard integration.
    Refused unless the row is currently offering exactly that. Home Assistant
    may drop the connection as it goes down, which is what a restart looks like
    from here and is not a failure; a call that never connected is."""
    started = time.monotonic()
    row = await dashboard_compat()
    if row is None or row["action"] != "restart":
        raise HTTPException(status_code=409, detail="A restart is not needed right now")
    try:
        await ha_call_service("homeassistant", "restart", {}, timeout=30)
        _action_ok("restart_ha", "'homeassistant.restart'", started)
    except (httpx.ReadError, httpx.RemoteProtocolError, httpx.ReadTimeout, httpx.WriteError) as exc:
        log_action.info("restart_ha ok: connection dropped as Home Assistant went down (%s)", _reason(exc))
    except httpx.HTTPError as exc:
        _action_failed("restart_ha", "'homeassistant.restart'", exc, started)
        raise HTTPException(status_code=502, detail=f"restart failed: {_ha_error_message(exc)}") from exc
    return {"ok": True}


# True once a sensor read has worked, False after one has failed, None before
# the first. The dashboard polls every 15 seconds per open tab, so a Home
# Assistant outage would otherwise write a line every poll: only the change
# (reachable -> unreachable, and back) is logged.
_ha_reachable: bool | None = None


@app.get("/api/action-items")
async def get_action_items() -> dict[str, Any]:
    global _ha_reachable
    result: dict[str, Any] = {}
    for key, entity_id in SENSORS.items():
        try:
            state = await ha_get_state(entity_id)
        except httpx.HTTPError as exc:
            if _ha_reachable is not False:
                log.warning(
                    "Home Assistant request for %s failed: %s "
                    "(not logged again until a request works)",
                    entity_id,
                    _reason(exc),
                )
            _ha_reachable = False
            raise HTTPException(status_code=502, detail=f"HA request failed for {entity_id}: {exc}") from exc
        raw_state = state.get("state", "0")
        try:
            count = int(raw_state)
        except (TypeError, ValueError):
            count = 0
        items = state.get("attributes", {}).get("items", [])
        result[key] = {"count": count, "items": items}
    try:
        dashboard_row = await dashboard_compat()
    except (httpx.HTTPError, ValueError) as exc:
        # Never lets this extra check break the page.
        log.debug("Dashboard compatibility check failed: %s", _reason(exc))
        dashboard_row = None
    if dashboard_row is not None:
        result["trouble"]["items"] = [dashboard_row] + list(result["trouble"]["items"])
        result["trouble"]["count"] += 1
    if _ha_reachable is False:
        log.info("Home Assistant is reachable again")
    _ha_reachable = True
    return result


# ---------------------------------------------------------------------
# Update jobs (1.3.5) -- one job per selected update, queued
# per-Portainer-endpoint, tracked independently, and polled for status
# instead of one blocking request processing the whole batch.
#
# The old /api/actions/install handled a whole multi-select batch inside a
# single HTTP request: a plain `for` loop awaited each perform_update call
# in turn before starting the next, all on the one connection the browser
# opened when the batch was submitted. That connection's lifetime scaled
# with the size (and luck) of the batch -- a big batch, or one slow item,
# could keep it open for minutes -- and it was that one long-lived
# connection, not "too many concurrent updates" (nothing here has ever
# sent Portainer more than one recreate at a time), that a reverse proxy
# or browser timeout would kill, reporting the *entire* batch as failed
# even while the server-side loop was still correctly working through it.
#
# Now: submitting a batch creates one job per update and returns almost
# immediately with a job id for each. Jobs are queued one-per-Portainer-
# endpoint (see _run_endpoint_queue) -- two endpoints' batches run
# concurrently since they're on separate queues, but within a single
# endpoint updates still go out strictly one at a time, since that's what's
# actually safe for its Docker daemon/Portainer agent to receive. Each
# job's own timeout (ha_call_service_with_response's 180s httpx timeout)
# is freshly scoped starting only when that job actually begins running --
# not when the batch was submitted, and not shifted by how many other jobs
# happened to be queued ahead of it on its endpoint.
JOB_RETENTION_SECONDS = 900
# How long a finished job's status stays queryable after it completes --
# long enough for a slow poller (or a page reload mid-batch) to still see
# the final outcome, short enough this dict never grows unbounded on a
# container that stays up for weeks.


@dataclass
class UpdateJob:
    id: str
    entity_id: str
    endpoint_key: str
    status: str = "queued"  # queued -> running -> succeeded | failed | timed_out
    queued_at: float = field(default_factory=time.monotonic)
    started_at: float | None = None
    finished_at: float | None = None
    error: str | None = None
    needs_stack_restart: bool = False
    stack_switch_entity_id: str | None = None


JOBS: dict[str, UpdateJob] = {}
_ENDPOINT_QUEUES: dict[str, "asyncio.Queue[str]"] = {}
_ENDPOINT_WORKERS: dict[str, asyncio.Task] = {}


def _get_endpoint_queue(endpoint_key: str) -> "asyncio.Queue[str]":
    queue = _ENDPOINT_QUEUES.get(endpoint_key)
    if queue is None:
        queue = asyncio.Queue()
        _ENDPOINT_QUEUES[endpoint_key] = queue
        # One long-lived worker per endpoint, created the first time that
        # endpoint is seen and kept running for the life of the process --
        # not spawned per batch, so a second batch against an endpoint
        # that's still working through its first one just appends to the
        # same queue instead of racing it.
        _ENDPOINT_WORKERS[endpoint_key] = asyncio.create_task(_run_endpoint_queue(endpoint_key))
    return queue


async def _run_endpoint_queue(endpoint_key: str) -> None:
    queue = _ENDPOINT_QUEUES[endpoint_key]
    while True:
        job_id = await queue.get()
        job = JOBS.get(job_id)
        if job is not None:
            await _run_job(job)
        queue.task_done()


async def _run_job(job: UpdateJob) -> None:
    job.status = "running"
    job.started_at = time.monotonic()
    log_action.info(
        "install started %s (job %s, waited %.1fs in the %s queue)",
        _q(job.entity_id),
        job.id[:8],
        job.started_at - job.queued_at,
        _q(job.endpoint_key),
    )
    try:
        response = await ha_call_service_with_response(
            "portainer_maintenance", "perform_update", {"update_entity": job.entity_id}
        )
        job.needs_stack_restart = bool(response.get("needs_stack_restart"))
        job.stack_switch_entity_id = response.get("stack_switch_entity_id")
        job.status = "succeeded"
        _action_ok(
            "install",
            f"{_q(job.entity_id)} (job {job.id[:8]})",
            job.started_at,
            " -- the owning stack needs a restart to finish" if job.needs_stack_restart else "",
        )
    except httpx.TimeoutException as exc:
        job.status = "timed_out"
        job.error = str(exc)
        log_action.warning(
            "install TIMED OUT %s (job %s): %s -- Home Assistant may still be working on it",
            _q(job.entity_id),
            job.id[:8],
            _reason(exc),
        )
    except httpx.HTTPError as exc:
        job.status = "failed"
        job.error = str(exc)
        _action_failed("install", f"{_q(job.entity_id)} (job {job.id[:8]})", exc, job.started_at)
    except Exception as exc:
        # Anything else (an empty or non-JSON 200 from HA, a null/list
        # service_response, ...). Must be caught here: this runs inside the
        # endpoint's single long-lived worker, and an exception escaping it
        # would end that worker for good -- the job stuck "running", every
        # later job for that endpoint stuck "queued" until the container
        # restarts. (CancelledError is a BaseException and still propagates.)
        job.status = "failed"
        job.error = f"{type(exc).__name__}: {exc}"
        log_action.exception("install FAILED %s (job %s) unexpectedly", _q(job.entity_id), job.id[:8])
    finally:
        job.finished_at = time.monotonic()


def _prune_old_jobs() -> None:
    now = time.monotonic()
    stale = [
        job_id
        for job_id, job in JOBS.items()
        if job.finished_at is not None and (now - job.finished_at) > JOB_RETENTION_SECONDS
    ]
    for job_id in stale:
        del JOBS[job_id]


class InstallJobRequest(BaseModel):
    entity_id: str
    # Which Portainer endpoint this update belongs to, used only to route
    # it onto that endpoint's own queue -- an opaque grouping key from the
    # frontend's own endpoint tree (host_device_id when known, else the
    # host name), not something this backend resolves itself. Updates that
    # don't carry one (or share the same fallback) simply queue together.
    endpoint_key: str = "_default"


class InstallRequest(BaseModel):
    updates: list[InstallJobRequest]


@app.post("/api/actions/install")
async def install_updates(payload: InstallRequest) -> dict[str, Any]:
    _prune_old_jobs()
    job_ids = []
    for item in payload.updates:
        job = UpdateJob(id=str(uuid.uuid4()), entity_id=item.entity_id, endpoint_key=item.endpoint_key)
        JOBS[job.id] = job
        _get_endpoint_queue(item.endpoint_key).put_nowait(job.id)
        job_ids.append(job.id)
    log_action.info(
        "install requested for %d update(s): %s",
        len(payload.updates),
        ", ".join(_q(u.entity_id) for u in payload.updates),
    )
    return {"job_ids": job_ids}


@app.get("/api/actions/install/status")
async def install_status(job_ids: str) -> dict[str, Any]:
    ids = [j for j in job_ids.split(",") if j]
    jobs = []
    for job_id in ids:
        job = JOBS.get(job_id)
        if job is None:
            # Already pruned, or the app restarted since this job was
            # submitted -- report it distinctly from a real failure so the
            # frontend can say so rather than implying the update itself
            # errored out.
            jobs.append(
                {
                    "id": job_id,
                    "entity_id": None,
                    "status": "unknown",
                    "error": "Job not found (may have expired, or the app restarted)",
                    "needs_stack_restart": False,
                    "stack_switch_entity_id": None,
                }
            )
            continue
        jobs.append(
            {
                "id": job.id,
                "entity_id": job.entity_id,
                "status": job.status,
                "error": job.error,
                "needs_stack_restart": job.needs_stack_restart,
                "stack_switch_entity_id": job.stack_switch_entity_id,
            }
        )
    return {"jobs": jobs}


class RestartStackRequest(BaseModel):
    switch_entity_id: str

    @field_validator("switch_entity_id")
    @classmethod
    def _must_be_a_switch_entity(cls, value: str) -> str:
        # Not a security boundary (whether this endpoint needs a sign-in is
        # decided by the auth gate near the top of this file, see README
        # "Authentication"), just a cheap sanity check against a stray
        # non-switch entity_id (e.g. a typo, or a stale value from
        # state.stackRestartEntries) reaching the
        # portainer_maintenance.restart_stack service, which itself just
        # does cv.entity_id and would happily stop/start whatever
        # entity_id it's handed.
        if not value.startswith("switch."):
            raise ValueError("switch_entity_id must be a switch.* entity")
        return value


@app.post("/api/actions/restart-stack")
async def restart_stack(payload: RestartStackRequest) -> dict[str, Any]:
    # Deliberately a separate, explicit tap -- never fired automatically
    # after install above, even though we already know a stack needs it.
    # A stack restart bounces every other container in it too, which
    # shouldn't happen without confirmation.
    #
    # (fix) 120s, not the default 30s: the integration's own restart_stack
    # service does a *blocking* switch.turn_off, a 5s settle, then a
    # blocking switch.turn_on -- and each of those blocking calls waits on
    # Portainer's own stop-stack/start-stack API call actually completing,
    # which for a multi-container stack (each container getting Docker's
    # own SIGTERM grace period before a SIGKILL) can easily run well past
    # 30s. A confirmed-in-production case: this exact call previously hit
    # the old 30s timeout and raised on the sidecar side while the restart
    # was still correctly running to completion on the HA side -- the
    # stack came back up fine, but the webapp reported a failure it never
    # actually had.
    started = time.monotonic()
    detail = _q(payload.switch_entity_id)
    log_action.info("restart_stack started %s (stops then starts every container in the stack)", detail)
    try:
        await ha_call_service(
            "portainer_maintenance",
            "restart_stack",
            {"switch_entity_id": payload.switch_entity_id},
            timeout=120,
        )
        _action_ok("restart_stack", detail, started)
    except httpx.HTTPError as exc:
        _action_failed("restart_stack", detail, exc, started)
        # (fix) Was `except httpx.HTTPStatusError` -- caught a bad HTTP
        # response from HA, but not a client-side timeout/connection
        # error (httpx.TimeoutException, httpx.ConnectError, etc, which
        # are httpx.RequestError, a sibling of HTTPStatusError under the
        # common httpx.HTTPError base, not a subclass of it). A timeout
        # used to propagate as an unhandled exception, which FastAPI turns
        # into a bare 500 with no detail -- exactly the "flashed an HTTP
        # 500 for some reason" symptom this was confirmed causing, on a
        # restart that was itself succeeding server-side the whole time.
        raise HTTPException(status_code=502, detail=f"restart_stack failed: {exc}") from exc
    return {"ok": True}


class DeleteStaleRequest(BaseModel):
    device_ids: list[str]


@app.post("/api/actions/delete-stale")
async def delete_stale_devices(payload: DeleteStaleRequest) -> dict[str, Any]:
    errors = []
    # remove_device has no undo, so each deletion is logged by device id (the
    # only name this app has for it) as it happens, not just in a summary.
    for device_id in payload.device_ids:
        started = time.monotonic()
        try:
            await ha_call_service("portainer_maintenance", "remove_device", {"device_id": device_id})
            _action_ok("delete_stale", f"device {_q(device_id)} removed", started)
        except httpx.HTTPError as exc:
            _action_failed("delete_stale", f"device {_q(device_id)}", exc, started)
            errors.append({"device_id": device_id, "error": str(exc)})
    log_action.info(
        "delete_stale finished: %d requested, %d removed, %d failed",
        len(payload.device_ids),
        len(payload.device_ids) - len(errors),
        len(errors),
    )
    return {"attempted": len(payload.device_ids), "errors": errors}


class PruneImagesRequest(BaseModel):
    dangling: bool = False
    until_hours: int | None = None
    # (1.3.0) targets a single endpoint's Cleanup-tab row instead of
    # always fanning out to every discovered host.
    device_ids: list[str] | None = None


@app.post("/api/actions/prune-images")
async def prune_images(payload: PruneImagesRequest) -> dict[str, Any]:
    # Delegates to portainer_maintenance.prune_images (HA side), which
    # discovers every Portainer endpoint device on its own via the device
    # registry (or targets exactly the given device_ids) and calls the
    # core portainer.prune_images action once per host.
    data: dict[str, Any] = {"dangling": payload.dangling}
    if payload.until_hours is not None:
        data["until_hours"] = payload.until_hours
    if payload.device_ids:
        data["device_ids"] = payload.device_ids
    started = time.monotonic()
    detail = (
        f"dangling={payload.dangling} until_hours={payload.until_hours} on "
        + (", ".join(_q(d) for d in payload.device_ids) if payload.device_ids else "every endpoint")
    )
    try:
        await ha_call_service("portainer_maintenance", "prune_images", data)
        _action_ok("prune_images", detail, started)
    except httpx.HTTPError as exc:
        _action_failed("prune_images", detail, exc, started)
        raise HTTPException(status_code=502, detail=f"prune_images failed: {exc}") from exc
    return {"ok": True}


class PruneVolumesRequest(BaseModel):
    device_ids: list[str] | None = None


@app.post("/api/actions/prune-volumes")
async def prune_volumes(payload: PruneVolumesRequest) -> dict[str, Any]:
    """(1.3.0, new) Delegates to portainer_maintenance.prune_volumes, which
    presses the button.*_volumes_prune entity for each targeted (or every
    discovered) endpoint -- see that service's own description for why a
    button.press wrapper, not a dedicated core service that doesn't exist."""
    data: dict[str, Any] = {}
    if payload.device_ids:
        data["device_ids"] = payload.device_ids
    started = time.monotonic()
    detail = "on " + (
        ", ".join(_q(d) for d in payload.device_ids) if payload.device_ids else "every endpoint"
    )
    try:
        await ha_call_service("portainer_maintenance", "prune_volumes", data)
        _action_ok("prune_volumes", detail, started)
    except httpx.HTTPError as exc:
        _action_failed("prune_volumes", detail, exc, started)
        raise HTTPException(status_code=502, detail=f"prune_volumes failed: {exc}") from exc
    return {"ok": True}


class ReloadEndpointRequest(BaseModel):
    device_id: str


@app.post("/api/actions/reload-endpoint")
async def reload_endpoint(payload: ReloadEndpointRequest) -> dict[str, Any]:
    """(1.3.0, new) Reloads the core portainer config entry that owns the
    given endpoint device -- the Trouble tab's remediation for an endpoint
    that's dropped its connection, the same reload Settings -> Devices &
    Services -> Portainer -> Reload performs from HA's own UI."""
    started = time.monotonic()
    detail = f"endpoint {_q(payload.device_id)}"
    try:
        await ha_call_service(
            "portainer_maintenance", "reload_endpoint", {"device_id": payload.device_id}
        )
        _action_ok("reload_endpoint", detail, started)
    except httpx.HTTPError as exc:
        _action_failed("reload_endpoint", detail, exc, started)
        raise HTTPException(status_code=502, detail=f"reload_endpoint failed: {exc}") from exc
    return {"ok": True}


class DismissRequest(BaseModel):
    dismiss_key: str

    @field_validator("dismiss_key")
    @classmethod
    def _check_key(cls, value: str) -> str:
        # Keys are "<kind>:<identity>" as built by the integration's trouble
        # sensor. This is only a sanity check so an arbitrary string can't
        # be stored in the integration's dismissal file; the integration
        # re-validates it too.
        value = value.strip()
        if ":" not in value or len(value) > 256:
            raise ValueError("dismiss_key must look like '<kind>:<id>'")
        return value


@app.post("/api/actions/dismiss")
async def dismiss_trouble_item(payload: DismissRequest) -> dict[str, Any]:
    """Hides one Needs Remediation item the user can't act on from here.
    Delegates to portainer_maintenance.dismiss_trouble_item (HA side),
    which owns how long a dismissal lasts. Needs an integration version
    that has that service; an older one answers 502 here."""
    started = time.monotonic()
    detail = _q(payload.dismiss_key)
    try:
        await ha_call_service(
            "portainer_maintenance", "dismiss_trouble_item", {"dismiss_key": payload.dismiss_key}
        )
        _action_ok("dismiss", detail, started)
    except httpx.HTTPError as exc:
        _action_failed("dismiss", detail, exc, started)
        raise HTTPException(status_code=502, detail=f"dismiss failed: {exc}") from exc
    return {"ok": True}


class UpdatePortainerRequest(BaseModel):
    update_entity: str

    @field_validator("update_entity")
    @classmethod
    def _check_entity(cls, value: str) -> str:
        # Sanity check only -- the integration re-validates that this is a
        # Portainer server/agent update entity and refuses anything else.
        value = value.strip()
        domain, _, object_id = value.partition(".")
        if domain != "update" or not object_id or len(value) > 255:
            raise ValueError("update_entity must look like 'update.<object_id>'")
        return value


def _ha_error_message(exc: httpx.HTTPError, limit: int | None = 500) -> str:
    """HA's REST API puts the reason a service call failed in the response
    body: a ServiceValidationError is a 400 with the text as JSON or plain
    text, any other HomeAssistantError a 500 with {"message": ...}. Pull
    that text out so the user sees "the update entity is not pending"
    instead of "Server error '500 Internal Server Error' for url ..."."""
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            body = response.json()
            if isinstance(body, dict) and body.get("message"):
                return str(body["message"])
        except ValueError:
            pass
        text = (response.text or "").strip()
        if text:
            return text if limit is None else text[:limit]
    return str(exc)


@app.post("/api/actions/update-portainer")
async def update_portainer(payload: UpdatePortainerRequest) -> dict[str, Any]:
    """Updates Portainer's own server or agent container, which the normal
    install path refuses (a container can't recreate itself). Delegates to
    portainer_maintenance.update_portainer (HA side), which starts a
    short-lived portainer-updater helper container and returns as soon as
    it has started -- the update itself then happens out of band and
    Portainer restarts partway through. Needs an integration version that
    has that service; an older one answers 502 here."""
    started = time.monotonic()
    detail = _q(payload.update_entity)
    log_action.info("update_portainer started %s (Portainer restarts partway through)", detail)
    try:
        result = await ha_call_service_with_response(
            "portainer_maintenance",
            "update_portainer",
            {"update_entity": payload.update_entity},
            timeout=330,
        )
        _action_ok("update_portainer", detail, started, f": {_q(result)}")
    except httpx.HTTPError as exc:
        _action_failed("update_portainer", detail, exc, started)
        raise HTTPException(
            status_code=502, detail=f"Portainer update failed: {_ha_error_message(exc)}"
        ) from exc
    return {"ok": True, **result}


# ---------------------------------------------------------------------
# Changelog (1.3.8) -- fetches a repo's latest GitHub release notes
# server-side and serves them from this app's own origin, so the frontend
# can render them in-app instead of linking out to github.com. Two earlier
# attempts (1.3.6, 1.3.7) tried to make the external link itself work from
# Home Assistant's companion app -- its embedded webview won't open a new
# window, and a same-window fallback can only navigate this app's own
# iframe, clobbering the panel it's rendered in when the destination
# (correctly) refuses to be framed. Serving our own copy of the content
# sidesteps the whole problem: nothing needs to open a new window, and
# there's no cross-origin framing question since it's this app's own
# origin either way.
CHANGELOG_CACHE_TTL_SECONDS = 3600
# GitHub's unauthenticated API allows 60 requests/hour per IP. Caching
# each repo's result here for an hour -- server-side, shared across every
# browser/tab that asks -- keeps this comfortably under that regardless of
# how often any one person reloads the page.
_CHANGELOG_CACHE: dict[str, tuple[float, dict[str, Any] | None]] = {}
_REPO_SLUG_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")


async def _fetch_github_release(repo: str) -> dict[str, Any] | None:
    headers = {
        "Accept": "application/vnd.github+json",
        # GitHub's API rejects requests with no User-Agent at all.
        "User-Agent": "ha-portainer-sidecar",
    }
    async with httpx.AsyncClient(timeout=10, headers=headers) as client:
        resp = await client.get(f"https://api.github.com/repos/{repo}/releases/latest")
        if resp.status_code == 404:
            # /releases/latest only ever returns a non-prerelease, non-draft
            # release -- a repo that only ever cuts prereleases (or hasn't
            # marked one "latest" yet) 404s here even though it does have
            # releases. Fall back to the newest release of any kind before
            # concluding there's nothing to show.
            resp = await client.get(f"https://api.github.com/repos/{repo}/releases?per_page=1")
            if resp.status_code != 200:
                return None
            releases = resp.json()
            if not releases:
                return None
            data = releases[0]
        elif resp.status_code == 200:
            data = resp.json()
        else:
            return None
    return {
        "repo": repo,
        "tag_name": data.get("tag_name"),
        "name": data.get("name") or data.get("tag_name"),
        "published_at": data.get("published_at"),
        "body": data.get("body") or "",
        "html_url": data.get("html_url"),
        "prerelease": bool(data.get("prerelease")),
    }


@app.get("/api/changelog/{repo:path}")
async def get_changelog(repo: str) -> dict[str, Any]:
    if not _REPO_SLUG_RE.match(repo):
        raise HTTPException(status_code=400, detail="repo must look like owner/name")

    now = time.monotonic()
    cached = _CHANGELOG_CACHE.get(repo)
    if cached is not None and (now - cached[0]) < CHANGELOG_CACHE_TTL_SECONDS:
        release = cached[1]
    else:
        try:
            release = await _fetch_github_release(repo)
        except httpx.HTTPError as exc:
            # Cached as "none" for CHANGELOG_CACHE_TTL_SECONDS below, so this
            # logs at most once per repo per TTL.
            log.warning("changelog lookup for %s failed: %s", _q(repo), _reason(exc))
            release = None
        _CHANGELOG_CACHE[repo] = (now, release)

    if release is None:
        raise HTTPException(status_code=404, detail=f"No release notes found for {repo}")
    return release


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok", "version": APP_VERSION}


@app.get("/version")
async def version() -> dict[str, str]:
    """What version this specific running container actually is -- answers
    "docker inspect --format '{{ index .Config.Labels
    \"org.opencontainers.image.version\" }}' ha-portainer-sidecar" or a plain
    `curl http://<host>:8000/version` without needing shell access to the
    container at all. Deliberately separate from /healthz (which also now
    includes it) so a version check reads clearly in logs/monitoring rather
    than looking like a health probe."""
    return {"version": APP_VERSION}


# Static frontend last, so it doesn't shadow the /api/* routes above.
app.mount("/", StaticFiles(directory="static", html=True), name="static")
