"""The dashboard that comes with the integration, in the sidebar as "Beacon".

Home Assistant has no public way for an integration to add a dashboard, so
this goes through Lovelace's internals: a YAML dashboard in its table and a
panel for it, the same two things Lovelace does for one declared in
configuration.yaml. If a Home Assistant release changes those internals,
the dashboard is skipped with a warning and the integration carries on;
dashboard.yaml can still be pasted in by hand (see README.md).
"""

import logging
import os

from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

URL_PATH = "beacon-dashboard"  # Lovelace requires a hyphen in dashboard paths
TITLE = "Beacon"
ICON = "mdi:music-circle"
FILENAME = os.path.join(os.path.dirname(__file__), "dashboard.yaml")


def register(hass: HomeAssistant) -> None:
    try:
        from homeassistant.components.frontend import async_register_built_in_panel
        from homeassistant.components.lovelace.const import LOVELACE_DATA
        from homeassistant.components.lovelace.dashboard import LovelaceYAML

        dashboards = hass.data[LOVELACE_DATA].dashboards
        if URL_PATH in dashboards:
            return
        dashboards[URL_PATH] = LovelaceYAML(
            hass,
            URL_PATH,
            {
                "mode": "yaml",
                # An absolute path: Lovelace joins it onto the config folder.
                "filename": FILENAME,
                "title": TITLE,
                "icon": ICON,
                "show_in_sidebar": True,
                "require_admin": False,
            },
        )
        async_register_built_in_panel(
            hass,
            "lovelace",
            frontend_url_path=URL_PATH,
            sidebar_title=TITLE,
            sidebar_icon=ICON,
            config={"mode": "yaml"},
            require_admin=False,
        )
    except Exception:
        _LOGGER.warning(
            "Could not add the Beacon dashboard to the sidebar; this Home Assistant "
            "version may have changed how dashboards work. Add dashboard.yaml by hand "
            "instead (see the integration's README).",
            exc_info=True,
        )


def remove(hass: HomeAssistant) -> None:
    try:
        from homeassistant.components.frontend import async_remove_panel
        from homeassistant.components.lovelace.const import LOVELACE_DATA

        if hass.data[LOVELACE_DATA].dashboards.pop(URL_PATH, None) is not None:
            async_remove_panel(hass, URL_PATH, warn_if_unknown=False)
    except Exception:
        _LOGGER.debug("Could not remove the Beacon dashboard", exc_info=True)
