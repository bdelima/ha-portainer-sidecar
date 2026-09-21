# Portainer Action Dashboard

A small, self-hosted web app that gives a real multi-select management UI for the Portainer container updates, container trouble, and stale-device tracking exposed by the [Portainer Maintenance](https://github.com/bdelima/ha-portainer-maintenance) Home Assistant integration — instead of the limits of a Lovelace dashboard.

It's a two-piece app: a small FastAPI backend that holds a Home Assistant long-lived access token server-side (never sent to the browser) and proxies a handful of endpoints, plus a static HTML/CSS/JS frontend served directly by that same backend. One container, no build step, no frontend framework.

## What it does

- Reads three Home Assistant sensors — `sensor.portainer_updates_pending`, `sensor.portainer_container_trouble`, `sensor.portainer_stale_devices` — via HA's REST API and renders them as three tabs (Updates / Trouble / Stale) with real checkboxes and a floating action bar.
- **Install updates**: select one or more pending `update.*` entities, calls `script.portainer_perform_update` for each.
- **Delete stale devices**: select one or more stale Portainer devices, calls `portainer_maintenance.remove_device` for each (a service provided by the [Portainer Maintenance](https://github.com/bdelima/ha-portainer-maintenance) integration — HA has no built-in way to delete a device from an automation/script).
- Polls for updates every 15 seconds.

This app doesn't create those sensors or that service itself — see the [Portainer Maintenance](https://github.com/bdelima/ha-portainer-maintenance) integration, which this app is designed to pair with.

## Configuration

Two required environment variables:

| Variable | Description |
|---|---|
| `HA_BASE_URL` | Your Home Assistant instance's base URL, e.g. `https://homeassistant.example.com` |
| `HA_TOKEN` (or `HA_TOKEN_FILE`) | A Home Assistant long-lived access token (Profile → Security → Long-Lived Access Tokens). Treat it as a secret with full API access as whichever HA user created it. `HA_TOKEN_FILE` (pointing at a mounted secret file) is preferred over the plain env var, since it keeps the token out of `docker inspect`/compose-file output. |

## Running it

A prebuilt, multi-arch (amd64/arm64) image is published to Docker Hub as
[`bdelima/portainer-action-dashboard`](https://hub.docker.com/r/bdelima/portainer-action-dashboard),
tagged both with each release version (see `VERSION`) and `latest` --
built and pushed automatically by this repo's own GitHub Actions workflow
on every version bump. Building from source (`build: .` / `docker build`)
still works and is what that workflow itself does, but pulling the image
is the faster path for normal use.

### Docker Compose

Add a service like this to an existing stack (or create your own):

```yaml
services:
  portainer-action-dashboard:
    image: bdelima/portainer-action-dashboard:latest
    container_name: portainer-action-dashboard
    restart: unless-stopped
    environment:
      HA_BASE_URL: "https://homeassistant.example.com"
      HA_TOKEN_FILE: /run/secrets/ha_token
    volumes:
      - ./ha_token:/run/secrets/ha_token:ro
    # No ports: mapping by default -- put a reverse proxy in front (see
    # "Security" below) rather than exposing port 8000 directly.
```

Create a plain-text `ha_token` file next to the compose file containing your long-lived access token, then `docker compose up -d`. (Swap `image:` for `build: .` if you'd rather build from source.)

### Docker directly

```bash
docker run -d \
  -e HA_BASE_URL="https://homeassistant.example.com" \
  -e HA_TOKEN="your-long-lived-access-token" \
  -p 8000:8000 \
  bdelima/portainer-action-dashboard:latest
```

### Building from source instead

```bash
docker build -t portainer-action-dashboard .
docker run -d \
  -e HA_BASE_URL="https://homeassistant.example.com" \
  -e HA_TOKEN="your-long-lived-access-token" \
  -p 8000:8000 \
  portainer-action-dashboard
```

## Versioning and publishing (maintainers)

The `VERSION` file at the repo root is the single source of truth. Bump
it and push to `main`, and `.github/workflows/docker-publish.yml` takes
it from there: it creates a matching GitHub Release (tag = the version
string), then builds and pushes the Docker Hub image tagged with that
version and `latest`. Nothing else to do by hand -- no separate release
step, no manual `docker push`.

One-time setup this workflow depends on (Docker Hub and GitHub secrets,
not something a workflow file can do for itself):

1. Docker Hub -> Account Settings -> Personal access tokens -> create one scoped to Read & Write for this repo.
2. GitHub repo -> Settings -> Secrets and variables -> Actions -> New repository secret, twice: `DOCKERHUB_USERNAME` (your Docker Hub username) and `DOCKERHUB_TOKEN` (the access token from step 1, not your Docker Hub password).

## Security

**Do not expose this app publicly.** Anyone who can reach it can install container updates and delete Home Assistant devices through it, with no auth layer of its own beyond whatever you put in front of it. Put it behind a reverse proxy scoped to your LAN, a VPN, or an authenticating proxy (e.g. Tailscale, or an Nginx Proxy Manager host restricted by IP/access list) — never expose port 8000 to the public internet directly.

## Embedding in Home Assistant

The [Portainer Maintenance](https://github.com/bdelima/ha-portainer-maintenance) integration registers a sidebar panel pointing at this app's URL automatically as part of its own setup — no manual dashboard configuration needed. See that repo's README for the full installation flow.

## License

MIT — see [LICENSE](LICENSE).
