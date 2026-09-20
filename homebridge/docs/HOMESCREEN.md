# homescreen.local deployment

Installed 19 September 2026 for the `pi` account.

- Homebridge: system service `homebridge`, UI at `http://homescreen.local:8581`.
- Plugin: `homebridge-powerwall-meters@0.1.1` in `/var/lib/homebridge/node_modules`.
- Package archive: `/var/lib/homebridge/homebridge-powerwall-meters-0.1.1.tgz`.
- Configuration: `/var/lib/homebridge/config.json`.
- Original configuration: `/var/lib/homebridge/config.json.before-powerwall-1789781765`.
- Original npm manifest: `/var/lib/homebridge/package.json.before-powerwall`.
- Matter child bridge: **Powerwall Meters**, UDP port 5541; HAP disabled for this child.

The existing MagicMirror display connects directly through v1r, without an HTTP
proxy. Homebridge therefore uses a new localhost-only proxy at `127.0.0.1:8675`.
It reuses the display's registered RSA key and password files in place; no secret
was copied to this repository or into Homebridge's configuration.

The proxy reports `Local (v1r)` using pypowerwall 0.17.3. Its user service is enabled
and the `pi` account already has lingering enabled, allowing it to start at boot.
The launcher sets the bind address to loopback and disables control commands.
All Homebridge control switches and native cumulative counters are initially off.
The four raw power meters and battery-status accessory are configured.

Live validation passed: all five Matter accessories registered, the bridge is
online on UDP 5541, and its persisted cluster state contains non-null live power
readings and battery percentage with `reachable: true` on every accessory.
The first startup exposed Matter's 32-character serial-number limit; v0.1.1
removes UUID hyphens from serials and bounds display labels to 32 UTF-8 bytes.
Regression validation: 16 plugin tests and 643 non-live Python tests passed.

## Operations

Run on homescreen as `pi`:

```sh
systemctl --user status powerwall-homebridge-proxy.service
systemctl --user restart powerwall-homebridge-proxy.service
curl http://127.0.0.1:8675/health
```

Proxy files are in `/home/pi/.local/share/powerwall-homebridge-proxy`:
`server.py`, `launch.py`, and non-secret connection paths in `connection.json`.
Its unit is `/home/pi/.config/systemd/user/powerwall-homebridge-proxy.service`.
Python is the existing `/home/pi/.local/share/MMM-PowerWallTV/v1r-venv/bin/python`.
Upgrades to that shared environment can affect both display and proxy.

Homebridge was reloaded through its existing supervisor, preserving pairing data.
Pair the **Powerwall Meters Matter child bridge**, not the main HAP bridge, in
Apple Home. Pairing and Apple UI rendering still require user verification.

For rollback, stop/disable the user proxy service, remove the PowerwallMeters
platform entry using Homebridge UI, uninstall this plugin, and restart Homebridge.
The saved original configuration can be restored only if no later unrelated
configuration changes need preserving. Do not remove the shared v1r environment,
registered key, password file, or MagicMirror installation.

## 0.2.0 upgrade (20 September 2026)

The upgrade adds proxy t102 and the directional meter profile, 22 battery contacts,
Below Backup Reserve and Grid Disconnected. Standard Tesla settings and Scheduled
Backup are exposed; physical grid commands remain opt-in. A private local token
file enables policy commands without putting a secret in Homebridge config.
The display currently owns grid export and operational mode through its 70–90%
automation; these two Home settings stay observational using
`externallyManagedControls: ["grid_export", "mode"]` until ownership is changed.
No startup or validation step writes Tesla settings.

All six directional meters use outlet presentation for Apple Home compatibility.
These overlap; Apple's sum must not be treated as household consumption. Cumulative
energy counters remain disabled. Switching profile/presentation replaces affected
meter endpoints; the existing bridge pairing and battery UUID are retained.

Deployment result: npm confirmed installation of 0.2.0 and the proxy restart
returned successfully. Backup suffix: `before-020-1789870265`. The next SSH
connection timed out before running the Homebridge reload or live validation;
subsequent SSH and web checks were also unreachable. **Live registration of the
new accessories is not yet verified.** Once connectivity returns, check proxy
`/homebridge/state`, restart the supervised Homebridge child, and inspect Matter
accessory reachability. Do not repeat installation or regenerate the control token.
Offline validation passed: 24 Node tests and 647 non-live Python tests.

Retry completed successfully on 20 September 2026. The supervised Homebridge
process loaded 0.2.0 and registered all 40 configured Matter accessories. A graceful
child restart flushed live state: all 40 were reachable, including all 22 SOC
threshold contacts. Battery reported 100%; the six directional power readings and
policy selections were populated correctly. Homebridge's accessories.json is a
registration/shutdown snapshot, not a continuously updated telemetry file.
No Tesla control writes were used for verification. The existing Matter pairing
was retained; Apple Home presentation still depends on the client UI.

## 0.2.1 clean pairing (20 September 2026)

Installed home-consumption profile: 35 accessories with exactly one electrical
power meter. The 22 threshold contacts, battery status, other status contacts and
policy controls are retained. Export and operational mode remain externally managed.
Old Powerwall commissioning storage is archived, not active. New Matter bridge:
`02:8E:DE:EA:50:75`, name **Powerwall Home Energy**, UDP 5541.
Configuration/package backups and old bridge storage are in
`/var/lib/homebridge/powerwall-backup-1789877418` (private directory).
Remove the old Powerwall bridge from Apple Home and pair the new Matter QR in
Homebridge UI. This deliberately resets Powerwall accessory identities; previous
room assignments and automations need recreating. The main Homebridge HAP identity
and UI configuration were preserved. Tests: 25 Node and 647 non-live Python passed.

## Main bridge migration (20 September 2026)

At the user's request, removed the Powerwall platform `_bridge` configuration.
All 35 accessories now register directly under main Matter identity
`0E:45:83:29:E8:D5`, UDP 5530, using the welcome-screen Matter pairing identity.
The main bridge's existing commissioned fabric was preserved. The former separate
Powerwall bridge no longer listens on UDP 5541; its storage is retained inactive.
Configuration backup: `config.json.before-main-matter-1789882174` in Homebridge storage.
This Matter-only plugin still publishes no HAP accessories. Future reloads must
restart the main Homebridge process, not a Powerwall child process.
