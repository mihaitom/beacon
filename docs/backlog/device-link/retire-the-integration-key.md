# Remove the old Home automation key

**Status:** announced as deprecated in the release after 1.11.0 (CHANGELOG
"Deprecated"); removal is a later release's decision. Nothing has been
removed yet, on purpose: anyone using it must have had time to switch.

Before removing, ship at least one release with the deprecation. The Home
Assistant repair (`home-assistant/custom_components/beacon/repairs.py`) has
worked on a real Home Assistant (2026-11-14).

## What goes

connect:

- `connect/core/integration_key.py` and its tests (`tests/test_integration_key.py`).
- `connect/routes/remote.py`: `POST`/`DELETE /remote/integration-key`, the
  integration-key branch of `require_remote_password()` (then `/remote/*`
  takes only the phone password again), the `is_integration` handling in
  `phone_events()`.
- `connect/core/remote.py`: `integration_streams` and its use in the phone
  count.
- `connect/core/mdns.py`: `steered_from_outside()` loses its
  `integration_key.is_set()` branch. The TXT property `path` (`/remote/`)
  only serves the old API; drop it together with its docs, keep `api`.
- The `/remote/status` field `integration` stays: a device key with control
  still keeps the window's relay running. Consider renaming it.

Frontend:

- `components/settings/HomeAutomationSection.vue` (key part, retiring notice)
  and where it is mounted; `services/remoteControl/http.ts`'s
  `generateIntegrationKey`/`revokeIntegrationKey`; the store actions of the
  same name in `stores/remoteControl.ts`; the `settings.homeAutomation*`
  strings in all five locales; their tests.

Home Assistant:

- `api.py` (the old client), the legacy branches in `config_flow.py`
  (`_check_legacy`, the host/port data), `make_client()`'s fallback and
  `_flag_integration_key()` in `__init__.py`, `repairs.py` and the `issues`
  strings. An entry still on the old key must then fail clearly (a reauth
  flow asking for a device key is the friendly version).

Docs:

- `docs/help/reference/home-automation-api.md`, the "older Home automation
  key" section of `docs/help/guides/home-automation.md`, the "Set up with the
  older key?" part of `home-assistant/README.md`, links to the reference
  (`grep -rn home-automation-api docs README.md home-assistant`).
- CHANGELOG: a "Removed" entry.
