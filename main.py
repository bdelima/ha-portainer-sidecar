"""Portainer Action Dashboard.

A small standalone web app giving a real, multi-select management UI for the
action items tracked by the Home Assistant Portainer automation set
(sensor.portainer_updates_pending, sensor.portainer_container_trouble,
sensor.portainer_stale_devices). Pairs with the "Portainer Maintenance" HA
custom integration (https://github.com/bdelima/ha-portainer-maintenance),
which registers a sidebar panel pointing at this app and creates the three
sensors it reads.

Runs as its own container. Holds the HA long-lived access token
server-side only -- it is never sent to the browser -- and proxies a
handful of read/action endpoints to HA's REST API. The frontend (static/)
is a plain HTML/JS page served by this same app.

Required environment variables:
    HA_BASE_URL   e.g. https://homeassistant.example.com
    HA_TOKEN      a Home Assistant long-lived access token (Profile ->
                  Security -> Long-Lived Access Tokens). Treat this as a
                  secret with full API access as whichever HA user created
                  it. Pass it via an env file / Docker secret (or
                  HA_TOKEN_FILE, below), never bake it into the image.
"""
from __future__ import annotations

import os
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

def _load_token() -> str:
    """Prefer a mounted secret file (HA_TOKEN_FILE) over a plain env var
    (HA_TOKEN), so the token doesn't need to sit in `docker inspect` output
    or a compose file. Either works."""
    token_file = os.environ.get("HA_TOKEN_FILE")
    if token_file:
        with open(token_file, encoding="utf-8") as f:
            return f.read().strip()
    return os.environ["HA_TOKEN"]


HA_BASE_URL = os.environ["HA_BASE_URL"].rstrip("/")
HA_TOKEN = _load_token()

HEADERS = {
    "Authorization": f"Bearer {HA_TOKEN}",
    "Content-Type": "application/json",
}

SENSORS = {
    "updates": "sensor.portainer_updates_pending",
    "trouble": "sensor.portainer_container_trouble",
    "stale": "sensor.portainer_stale_devices",
}

app = FastAPI(title="Portainer Action Dashboard")


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


@app.get("/api/config")
async def get_config() -> dict[str, str]:
    # HA_BASE_URL itself isn't sensitive (unlike HA_TOKEN) -- the frontend
    # needs it to build "open in Home Assistant" links for device pages.
    return {"ha_base_url": HA_BASE_URL}


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
    for entity_id in payload.update_entities:
        try:
            await ha_call_service("portainer_maintenance", "perform_update", {"update_entity": entity_id})
        except httpx.HTTPStatusError as exc:
            errors.append({"entity": entity_id, "error": str(exc)})
    return {"attempted": len(payload.update_entities), "errors": errors}


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


@app.post("/api/actions/prune-images")
async def prune_images(payload: PruneImagesRequest) -> dict[str, Any]:
    # Delegates to portainer_maintenance.prune_images (HA side), which
    # discovers every Portainer endpoint device on its own via the device
    # registry and calls the core portainer.prune_images action once per
    # host -- this app never needs to know host/device_ids itself.
    data: dict[str, Any] = {"dangling": payload.dangling}
    if payload.until_hours is not None:
        data["until_hours"] = payload.until_hours
    try:
        await ha_call_service("portainer_maintenance", "prune_images", data)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"prune_images failed: {exc}") from exc
    return {"ok": True}


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


# Static frontend last, so it doesn't shadow the /api/* routes above.
app.mount("/", StaticFiles(directory="static", html=True), name="static")
