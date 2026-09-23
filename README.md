# Portainer Sidecar

A small, self-hosted web app that gives a real multi-select management UI for the Portainer container updates, trouble, stale-device, and image/volume cleanup tracking exposed by the [Portainer Maintenance](https://github.com/bdelima/ha-portainer-dashboard) Home Assistant integration — instead of the limits of a Lovelace dashboard.

It's a two-piece app: a small FastAPI backend that holds a Home Assistant long-lived access token server-side (never sent to the browser) and proxies a handful of endpoints, plus a static HTML/CSS/JS frontend served directly by that same backend. One container, no build step, no frontend framework.

## What it does

- Reads four Home Assistant sensors — `sensor.portainer_updates_pending`, `sensor.portainer_trouble`, `sensor.portainer_stale_devices`, `sensor.portainer_cleanup` *(1.3.0, new)* — via HA's REST API and renders them as four tabs (Updates / Trouble / Stale / Cleanup), each tree-grouped by Portainer endpoint.
  - *(1.3.0, breaking rename)* `sensor.portainer_trouble` was `sensor.portainer_container_trouble` on the integration side — this app follows that rename automatically, nothing to configure here, just noting it in case you have anything else referencing the old entity_id.
- **Install updates**: select one or more pending `update.*` entities, calls `portainer_maintenance.perform_update` for each.
- **Endpoint → stack → container tree** *(1.3.0)*: the Updates tab now groups by Portainer endpoint first, then by stack (when one applies) — previously stack-only, with no endpoint level, which flattened everything into one list on a setup with a single endpoint or no stacks. Checkboxes cascade at every level: selecting an endpoint or a stack selects everything under it. Containers that aren't part of a stack sit directly under their endpoint, not under a fake "Standalone" placeholder.
- **Stack trouble badge** *(1.3.0)*: a stack's row on the Updates tab shows a warning badge when that stack currently has an open Trouble item — most often a container stuck on the `network_mode: service:<other>` recreate limitation described below. The idea is to make it obvious *before* you install another update in that same stack that something in it still needs attention, rather than only finding out afterward.
- **Trouble tab, broadened** *(1.3.0)*: previously just exited/unhealthy containers, now also covers a Portainer endpoint that's silently dropped its connection (with a one-tap **Reload Endpoint** action) and a container stuck on the confirmed Portainer/Docker limitation where recreating a container sharing another container's network (e.g. a VPN sidecar like gluetun) fails at the daemon level. When that stuck container belongs to a real Portainer stack, its row (nested under the stack) carries a **Restart Stack Now** action; when it doesn't (most likely an unmanaged Compose project), there's no stack to restart, so the row instead offers a **More Info** action explaining the situation, since it doesn't fit in the row's short status text. This replaces the old always-visible stack-restart banner entirely — the banner's one-tap restart button is now this per-stack action on the Trouble tab instead.
- **Cleanup tab** *(1.3.0, new, replaces the old maintenance toolbar)*: the previous always-visible checkbox+hours-input toolbar above the tabs is gone. In its place, a proper 4th tab, tree-grouped by endpoint, with three fixed, ordered per-endpoint actions — Clean dangling images, Reclaim all images, Prune unused volumes — each an immediate button, not a batch-select model. Reclaim and Prune ask for confirmation first (both are irreversible); dangling-image cleanup doesn't, since by definition nothing dangling is referenced by any container. Badges show a rough unused-image estimate and, where available, a byte-accurate reclaimable-space figure in GB (shown as a neutral placeholder rather than a false zero when HA's own sensor reads `unknown`/`unavailable`).
- **Delete stale devices**: select one or more stale Portainer devices, calls `portainer_maintenance.remove_device` for each (a service provided by the [Portainer Maintenance](https://github.com/bdelima/ha-portainer-dashboard) integration — HA has no built-in way to delete a device from an automation/script). Now grouped by endpoint on the Stale tab too, with the same cascading-checkbox model as Updates.
- **Changelog links**: when a pending update's image resolves to a known upstream GitHub repo — either from the integration's small hand-curated table, or found automatically for `ghcr.io`/Docker Hub images — a "Changelog" link appears next to Install, opening that project's releases page in a new tab. Not every image resolves to one; when none is found, the link is simply omitted.
- **Deep link to the Trouble tab** *(1.3.0)*: opening this app with `#trouble` on the URL (which the integration's own push notifications now use for anything trouble-related) lands directly on that tab instead of wherever the app was last left.
- Polls for updates every 15 seconds.

This app doesn't create those sensors or those services itself — see the [Portainer Maintenance](https://github.com/bdelima/ha-portainer-dashboard) integration, which this app is designed to pair with.

## Requirements

This app itself has no Home Assistant version dependency of its own — it only talks to whatever sensors and services the [Portainer Maintenance](https://github.com/bdelima/ha-portainer-dashboard) integration exposes over HA's REST API. That integration currently requires **Home Assistant 2026.8 or later**, and has only been run and tested against **Home Assistant Container Edition**; see its README for details. If this app's tabs look empty or the sensors above 404, check that the integration itself is installed and set up correctly before troubleshooting this app.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `HA_TOKEN` (or `HA_TOKEN_FILE`) | Yes | A Home Assistant long-lived access token (Profile → Security → Long-Lived Access Tokens). Treat it as a secret with full API access as whichever HA user created it. `HA_TOKEN_FILE` (pointing at a mounted secret file) is preferred over the plain env var, since it keeps the token out of `docker inspect`/compose-file output. |
| `HA_BASE_URL` | No | Your Home Assistant instance's base URL, e.g. `http://homeassistant:8123`. If omitted, the app auto-discovers it on startup (see below) — set this explicitly only if discovery doesn't find your setup, or if you want to pin it. |
| `HA_PUBLIC_URL` | No | The browser-facing URL for "open in Home Assistant" links (e.g. `https://homeassistant.example.com`). Only meaningful if you've also set `HA_BASE_URL` explicitly to something a browser can't reach (a container hostname or internal IP) — reused automatically for links whenever `HA_BASE_URL` was set by hand. Not needed if you let auto-discovery find `HA_BASE_URL`, since discovery only accepts addresses that are already browser-reachable on your LAN. |

### Auto-discovery

If `HA_BASE_URL` isn't set, the app looks for Home Assistant automatically on startup, in this order, stopping at the first instance that answers with an unauthenticated `/manifest.json` fingerprint check (no token is sent during discovery):

1. **Common HA container hostnames** — tries `homeassistant`, `home-assistant`, `hass`, and `ha` on port 8123 via Docker's embedded DNS, for the usual case of this app and HA sharing a Docker network.
2. **This container's own `/24` subnet** — scans it for anything answering on port 8123.
3. **The Docker host itself** — the default gateway address and `host.docker.internal`, for HA running directly on the host or in a different Docker network.

If none of these find anything, the app fails to start with a clear error asking you to set `HA_BASE_URL` explicitly. This covers the common case of everything running on one box; if your setup is unusual (HA on a separate host with no route from this container, custom networking, etc.), just set `HA_BASE_URL` yourself and discovery is skipped entirely.

## Running it

A prebuilt, multi-arch (amd64/arm64) image is published to Docker Hub as
[`bdelima/ha-portainer-sidecar`](https://hub.docker.com/r/bdelima/ha-portainer-sidecar),
tagged both with each release version (see `VERSION`) and `latest` --
built and pushed automatically by this repo's own GitHub Actions workflow
on every version bump. Building from source (`build: .` / `docker build`)
still works and is what that workflow itself does, but pulling the image
is the faster path for normal use.

### Docker Compose

Add a service like this to an existing stack (or create your own):

```yaml
services:
  ha-portainer-sidecar:
    image: bdelima/ha-portainer-sidecar:latest
    container_name: ha-portainer-sidecar
    restart: unless-stopped
    environment:
      HA_TOKEN_FILE: /run/secrets/ha_token
      # HA_BASE_URL: "http://homeassistant:8123"  # only needed if auto-discovery doesn't find your HA instance
    volumes:
      - ./ha_token:/run/secrets/ha_token:ro
    # No ports: mapping by default -- put a reverse proxy in front (see
    # "Security" below) rather than exposing port 8000 directly.
```

Create a plain-text `ha_token` file next to the compose file containing your long-lived access token, then `docker compose up -d`. (Swap `image:` for `build: .` if you'd rather build from source.)

### Docker directly

```bash
docker run -d \
  -e HA_TOKEN="your-long-lived-access-token" \
  -p 8000:8000 \
  bdelima/ha-portainer-sidecar:latest
```

### Building from source instead

```bash
docker build -t ha-portainer-sidecar .
docker run -d \
  -e HA_TOKEN="your-long-lived-access-token" \
  -p 8000:8000 \
  ha-portainer-sidecar
```

## Versioning and publishing (maintainers)

The `VERSION` file at the repo root is the single source of truth. Bump
it and push to `main`, and `.github/workflows/docker-publish.yml` takes
it from there: it creates a matching GitHub Release (tag = the version
string), then builds and pushes the Docker Hub image tagged with that
version and `latest`. Nothing else to do by hand -- no separate release
step, no manual `docker push`.

The built image also carries standard OCI labels (`org.opencontainers.image.version`,
`.revision`, `.source`, `.url`, `.licenses`), so a running container's exact
version and build commit are checkable via `docker inspect` even when
deployed as `:latest` -- or via the app's own `GET /version` endpoint,
which reads the same version from its `APP_VERSION` env var.

One-time setup this workflow depends on (Docker Hub and GitHub secrets,
not something a workflow file can do for itself):

1. Docker Hub -> Account Settings -> Personal access tokens -> create one scoped to Read & Write for this repo.
2. GitHub repo -> Settings -> Secrets and variables -> Actions -> New repository secret, twice: `DOCKERHUB_USERNAME` (your Docker Hub username) and `DOCKERHUB_TOKEN` (the access token from step 1, not your Docker Hub password).

## Security

**Do not expose this app publicly.** Anyone who can reach it can install container updates and delete Home Assistant devices through it, with no auth layer of its own beyond whatever you put in front of it. Put it behind a reverse proxy scoped to your LAN, a VPN, or an authenticating proxy (e.g. Tailscale, or an Nginx Proxy Manager host restricted by IP/access list) — never expose port 8000 to the public internet directly.

## Embedding in Home Assistant

The [Portainer Maintenance](https://github.com/bdelima/ha-portainer-dashboard) integration registers a sidebar panel pointing at this app's URL automatically as part of its own setup — no manual dashboard configuration needed. See that repo's README for the full installation flow.

## License

MIT — see [LICENSE](LICENSE).
