# HAP-only v0.3.0 migration

Matter v0.2.13 is preserved on GitHub branch `codex/powerwall-matter-0.2.13`.
HAP development is on `codex/powerwall-hap-only`.

The HAP transport registers native Homebridge platform accessories and never
accesses api.matter. Standard services cover Outlet, Switch, ContactSensor and
Battery. Power/energy use custom read-only HAP characteristics; this is not a
promise of Apple Home native energy support. Existing polling, confirmed controls
and threshold logic are retained.

For homescreen.local, keep the main HAP identity and current platform config,
including reserve presets [10,20]. Disable bridge.matter.enabled, install v0.3.0
and restart Homebridge. Preserve Matter storage and do not reset HAP pairing.
A private timestamped config backup is created before migration. The v0.2.13
archive remains on the host for rollback.

If the main HAP bridge is already paired, its accessories should be discovered
through that pairing; otherwise use its welcome-screen HAP QR/code. Matter room
assignments and automations do not migrate to HAP.

## Verified deployment — 20 September 2026

Installed 0.3.0 on homescreen.local and disabled Matter on the main bridge.
Config backup: `/var/lib/homebridge/config.json.before-hap-030-1789887676`.
Homebridge started successfully at 17:01:25 Melbourne time. The dashboard shows
34 HAP accessories (35 service tiles because the low-battery accessory also has
a Battery service), all requested threshold labels, native policy switches, and
Home consumption On. The Battery service displayed 100%, Not Charging.
No Tesla control commands were issued during validation. Apple Home pairing and
room assignment still require the user's device. Existing HAP identity preserved.

Validation: 28 Node tests, including actual HAP service reads, cache restoration,
read-only meter writes and failed controls; 647 non-live Python tests passed.
