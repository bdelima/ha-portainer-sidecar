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
"""
from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

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
        print(f"[startup] HA_BASE_URL not set -- auto-discovered Home Assistant at {HA_BASE_URL}")
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


async def ha_call_service(domain: str, service: str, data: dict[str, Any]) -> None:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{HA_BASE_URL}/api/services/{domain}/{service}", headers=HEADERS, json=data
        )
        resp.raise_for_status()


async def ha_call_service_with_response(domain: str, service: str, data: dict[str, Any]) -> dict[str, Any]:
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
    correctly working it out."""
    async with httpx.AsyncClient(timeout=180) as client:
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


@app.get("/api/action-items")
async def get_action_items() -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, entity_id in SENSORS.items():
        try:
            state = await ha_get_state(entity_id)
        except httpx.HTTPStatusError as exc:
            raise HTTPException(status_code=502, detail=f"HA request failed for {entity_id}: {exc}") from exc
        raw_state = state.get("state", "0")
        try:
            count = int(raw_state)
        except (TypeError, ValueError):
            count = 0
        items = state.get("attributes", {}).get("items", [])
        result[key] = {"count": count, "items": items}
    return result


class InstallRequest(BaseModel):
    update_entities: list[str]


@app.post("/api/actions/install")
async def install_updates(payload: InstallRequest) -> dict[str, Any]:
    errors = []
    needs_stack_restart = []
    for entity_id in payload.update_entities:
        try:
            response = await ha_call_service_with_response(
                "portainer_maintenance", "perform_update", {"update_entity": entity_id}
            )
        except httpx.HTTPStatusError as exc:
            errors.append({"entity": entity_id, "error": str(exc)})
            continue
        # A phone push already went out from the HA side either way (see
        # perform_update's own docstring) -- this is additive, so whoever's
        # sitting at the dashboard right now doesn't have to go find their
        # phone to notice a stack needs restarting.
        if response.get("needs_stack_restart"):
            needs_stack_restart.append(
                {
                    "entity": entity_id,
                    "stack_switch_entity_id": response.get("stack_switch_entity_id"),
                }
            )
    return {
        "attempted": len(payload.update_entities),
        "errors": errors,
        "needs_stack_restart": needs_stack_restart,
    }


class RestartStackRequest(BaseModel):
    switch_entity_id: str

    @field_validator("switch_entity_id")
    @classmethod
    def _must_be_a_switch_entity(cls, value: str) -> str:
        # This app has no auth of its own (see README "Security"), same as
        # every other endpoint here -- this isn't a security boundary, just
        # a cheap sanity check against a stray non-switch entity_id (e.g. a
        # typo, or a stale value from state.stackRestartEntries) reaching
        # the portainer_maintenance.restart_stack service, which itself
        # just does cv.entity_id and would happily stop/start whatever
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
    try:
        await ha_call_service(
            "portainer_maintenance", "restart_stack", {"switch_entity_id": payload.switch_entity_id}
        )
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"restart_stack failed: {exc}") from exc
    return {"ok": True}


class DeleteStaleRequest(BaseModel):
    device_ids: list[str]


@app.post("/api/actions/delete-stale")
async def delete_stale_devices(payload: DeleteStaleRequest) -> dict[str, Any]:
    errors = []
    for device_id in payload.device_ids:
        try:
            await ha_call_service("portainer_maintenance", "remove_device", {"device_id": device_id})
        except httpx.HTTPStatusError as exc:
            errors.append({"device_id": device_id, "error": str(exc)})
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
    try:
        await ha_call_service("portainer_maintenance", "prune_images", data)
    except httpx.HTTPStatusError as exc:
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
    try:
        await ha_call_service("portainer_maintenance", "prune_volumes", data)
    except httpx.HTTPStatusError as exc:
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
    try:
        await ha_call_service(
            "portainer_maintenance", "reload_endpoint", {"device_id": payload.device_id}
        )
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"reload_endpoint failed: {exc}") from exc
    return {"ok": True}


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
