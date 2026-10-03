# Attribution

This repository's own code is licensed under the MIT License (see `LICENSE`). It uses or builds on the third-party projects below, each under its own license and copyright; nothing here relicenses them.

## Home Assistant

- **Project:** [home-assistant/core](https://github.com/home-assistant/core)
- **License:** Apache-2.0
- **How it's used:** the backend calls Home Assistant's REST API with a long-lived access token. No Home Assistant code is included.

## Portainer

- **Project:** [portainer/portainer](https://github.com/portainer/portainer)
- **License:** zlib
- **How it's used:** this app manages the Portainer maintenance data exposed through Home Assistant; it does not include or call Portainer code directly.

## Python dependencies

Installed from PyPI at image build time, unmodified; exact pins are in `requirements.txt`.

- **fastapi:** MIT
- **uvicorn:** BSD-3-Clause
- **httpx:** BSD-3-Clause

## Trademarks

"Portainer" and "Home Assistant" are trademarks of their respective owners. This is an unofficial project, not affiliated with or endorsed by them.
