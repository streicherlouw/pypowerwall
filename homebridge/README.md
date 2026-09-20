# homebridge-powerwall-meters — HAP edition

Version 0.4.2 publishes **HomeKit HAP only**, using the pypowerwall HTTP proxy.
It does not register Matter endpoints or require Matter to be enabled. The previous
Matter version is preserved on branch `codex/powerwall-matter-0.2.13`.

## Installation and migration

Requires Homebridge 2.4+, Node 22/24/26, and proxy t102 for the optional controls.
Build with `npm ci --ignore-scripts`, `npm test`, and `npm pack` in this directory.
Install the resulting `homebridge-powerwall-meters-0.4.2.tgz` in your Homebridge
plugin installation directory. This package is not published to npm.

Keep the existing `PowerwallMeters` platform configuration and `siteId`. Disable
Matter on the bridge and restart Homebridge. Pair the main **HAP** QR/code shown
on Homebridge's welcome screen, unless that HAP bridge is already in Apple Home.
Do not create a child bridge if you want to use the main welcome-screen identity.
A child bridge has its own pairing identity.

HAP and Matter pairings are separate: changing protocol cannot transfer Apple Home
rooms, names or automations. Remove the old Matter bridge from Apple Home when you
are ready to retire it. Preserve its storage and the v0.2.13 package for rollback;
do not reset or delete the existing HAP identity. Version 0.4 groups all services into one Powerwall accessory, with Home consumption
as its primary service. Assign this accessory to a room once; its services share
that room. Apple Home controls their tile and automation presentation.

Upgrading from v0.3 removes the separate accessories and registers the grouped
replacement. Automations referencing those old accessories need recreating.
The bridge pairing is preserved; no pairing reset is needed for this migration.
Service subtypes remain stable across subsequent restarts and configuration changes.

```json
{
  "platform": "PowerwallMeters",
  "name": "Powerwall",
  "siteId": "my-powerwall",
  "proxyUrl": "http://127.0.0.1:8675",
  "meterProfile": "home-consumption",
  "outletMeters": ["load"],
  "nativeEnergyMeters": [],
  "batteryStatus": true,
  "thresholdSensors": true,
  "lowBatteryPercent": 20,
  "pollSeconds": 15,
  "staleSeconds": 90
}
```

## What appears in Home

- **Home consumption**: an always-on, read-only Outlet. Toggling it is rejected;
  it never disconnects the house. Power remains a live meter value.
- **Low Battery Warning**: a ContactSensor, open at or below 20% by default,
  with a linked standard Battery service (BatteryLevel, StatusLowBattery,
  ChargingState). Battery percentage is rounded to whole percent for HAP.
- **22 battery threshold contacts**: Below/Above each configured ten-percent
  increment. Below 0 is presented/evaluated as **Below 1 Percent Battery**;
  Above 100 as **Above 99 Percent Battery**. Above 0 remains unchanged.
- Optional grid and below-reserve contacts, and native Switch services for controls.

Contacts open when their condition is active. Threshold comparisons are strict;
clearing hysteresis defaults to 2 percentage points. For example Below 1 opens
below 1% and clears at 3%; Above 99 opens above 99% and clears at 97%. Missing
readings produce HAP communication errors and StatusFault, never fabricated zeroes.

**Power display limitation:** HAP has no standard watts or cumulative-energy
characteristic used here. The plugin publishes read-only custom Power (W), Imported
Energy (kWh), and Exported Energy (kWh) characteristics. Compatible third-party HAP
clients can inspect these; Apple Home and Homebridge UI may omit them. Do not
expect the Matter version's native energy display or energy aggregation in HAP.
The standard Battery service is available independently of these custom values;
its exact placement depends on the controller UI.

The default `home-consumption` profile exposes only load. `compact` exposes selected
raw `meters` (`load`, `solar`, `site`, `battery`); `directional` splits grid and battery
into positive directional values. Non-outlet meters use a custom HAP meter service
and may not appear in Apple Home. Raw signs are retained: grid import and battery
discharge positive, export and charge negative. No solar-to-home flow is inferred.

`nativeEnergyMeters` retains its config name for compatibility but selects custom
HAP kWh counters, not Matter energy reporting. Only enable verified real gateway
counters. Values are converted from Wh, refreshed at most once a minute, and never
integrated, synthesized, or stitched across resets.

## Controls

Controls are opt-in. Set the proxy's `PW_CONTROL_SECRET` and provide its matching
value through `controlTokenEnv` (environment-variable name) or `controlTokenFile`
(absolute, private 0600 file). Never put the token directly in Homebridge config.
Set `controlAuthority: "homebridge"` to permit writes; `"external"` is read-only.
Other applications may control the Powerwall concurrently. There is no conflict
lockout; the next poll reconciles the display.

- `energyExportSwitches`: Export Solar Only / Export Battery & Solar.
- `operationalModeSwitches`: Self Powered Operating Mode / Savings Operating Mode.
- `backupReservePresets: [10,20]`: 10 Percent Backup / 20 Percent Backup.
- `gridChargingSwitch`: Grid Charging.
- `scheduledBackupSwitch` and `scheduledBackupHours` (default 2): scheduled backup.
- `belowReserveSensor`, `gridStatusSensor`: read-only condition contacts.
- `advancedGridControls`: opt-in Go Off-Grid / Reconnect to Grid momentary commands.

Select a different policy or reserve switch to change a choice; turning the active
choice off is rejected. Scheduled Backup can be cancelled by turning it off.
Writes require acknowledgement and readback; they are never retried automatically.
Polling and control queues are separate and no control writes occur during startup.
Use a trusted LAN or authenticated tunnel: the proxy token travels in POST bodies.
The existing display/v1r credentials and Python APIs are unchanged.

## Validation

`npm test` exercises policy/threshold behavior and real HAP services, registration,
cache restoration, errors and recovery. Tests do not open sockets or control real
hardware. `npm run check` checks syntax. Python/proxy validation from repo root:
`pytest -m "not live" --no-cov`.

Historical Matter research and deployment notes in `docs/` describe v0.2 and are
not claims about HAP support. See `docs/HAP_MIGRATION.md` for this installation.

## Grouped sensor names in Apple Home

Apple Home may show generic type names in its multi-sensor pairing wizard and
write them back to ConfiguredName. Version 0.4.1 repairs English placeholders
such as Contact Sensor 12 after the write completes, publishes the descriptive
name on reads, and preserves deliberate custom names across restarts. This cannot
control the text Apple initially chooses in its pairing wizard. Complete setup
and reopen Home to check the final names; do not reset pairing just for names.

Version 0.4.2 also sends an explicit ConfiguredName event when a controller
subscribes, to help refresh labels retained by Home. A controller-local alias
may still require editing in Home. Live watts are additionally published using
the established Eve Current Consumption UUID E863F10D-079E-48FF-8F27-9C2605A29F52
for compatible HAP clients. This is a vendor characteristic, not standard Apple
Home energy support; it does not provide history or guarantee a Home wattage tile.
