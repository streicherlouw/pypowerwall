# Definitive Powerwall Homebridge release

Version: **0.7.1**. Git tag: **homebridge-v0.7.1**.
Validated deployment: homescreen.local, 21 September 2026.
This document supersedes the earlier HAP and grouped Matter deployment notes.

## Final design

The plugin uses the main Homebridge Matter bridge, with individually named
accessories and no plugin HAP accessories or child bridge. The selected `net-grid` profile attaches native power measurement
to Home consumption, Solar generation and Battery. Separate accessory names are present at
registration; there is no periodic name-refresh workaround.

The installation exposes these 13 accessories:

| Accessory | Behavior |
| --- | --- |
| Home consumption | Native load power in watts; always on, read-only |
| Solar generation | Negative generation watts; always on, read-only |
| Battery | Positive charging / negative discharge watts; native SOC and charging metadata; always on, read-only |
| Low Battery Warning | Opens at or below 20%; contact only |
| Below 65 Percent | Opens below 65%; clears at 67% or higher |
| Above 90 Percent | Opens above 90%; clears at 88% or lower |
| Export Solar Only | Selects `pv_only` export policy |
| Export Battery & Solar | Selects `battery_ok` export policy |
| Self Powered Operating Mode | Selects `self_consumption` |
| Savings Operating Mode | Selects `autonomous` |
| 10 Percent Backup | Selects 10% backup reserve |
| 20 Percent Backup | Selects 20% backup reserve |
| Grid Charging | Enables/disables grid charging |

Contacts are closed when inactive. At 75% charge, both limit contacts are closed,
including after previously crossing either limit. The 2 percentage point hysteresis
only affects clearing. Missing charge is reported unavailable, not as zero.
Limits are edited in Homebridge settings; restarting applies their values and names.
The package's generic lower default remains 70%; this installation overrides it to 65%.

Scheduled Backup, Below Backup Reserve and Grid Disconnected are removed from the
plugin. Physical grid commands remain optional and are disabled on homescreen.
The 22 fixed thresholds and the composed layout are superseded. Changing accessory
structure may require rebuilding Apple Home room assignments and automations.

## Installation settings

Plugin directory: `/var/lib/homebridge/node_modules/homebridge-powerwall-meters`.
Configuration: `/var/lib/homebridge/config.json`.
Proxy: loopback-only `http://127.0.0.1:8675`, pypowerwall v1r transport using the
existing registered local key. Credentials and token contents are not included here.
The policy token is read from a private file, not embedded in the configuration.

Selected settings (merge into the existing platform; preserve siteId and credentials):

```json
{
  "meterProfile": "net-grid",
  "outletMeters": ["load"],
  "nativeEnergyMeters": [],
  "batteryStatus": true,
  "lowBatteryPercent": 20,
  "thresholdSensors": true,
  "belowLimitPercent": 65,
  "aboveLimitPercent": 90,
  "thresholdHysteresis": 2,
  "energyExportSwitches": true,
  "operationalModeSwitches": true,
  "backupReservePresets": [10, 20],
  "gridChargingSwitch": true,
  "advancedGridControls": false,
  "controlAuthority": "homebridge"
}
```

Control writes require gateway acknowledgement and readback. Independent modules
may also manage the Powerwall; conflict detection is intentionally absent. The user
controls write access through `controlAuthority`. Startup and polling issue no
Tesla control writes.

## Pairing and operational notes

Use the main Homebridge welcome-screen Matter QR code. HAP pairing does not expose
these accessories; no standalone meter or child-bridge pairing is required.
The user confirmed all three meter tiles display watts after removing the old
Apple Home bridge, clearing the main bridge's Matter pairing in Homebridge, and
pairing again. Earlier upgrades displayed room totals but omitted Solar/Battery
individual readings, even after endpoint recreation. A clean main-bridge pairing
resolved that observed issue; the internal Apple cause is not proven.

The confirmed screenshot shows Home consumption +1.40 kW, Solar generation −6.19 kW,
Battery +13 W, and room total −4.77 kW. Values are rounded and update asynchronously.
The signed sum estimates grid import (+) / export (−). The measured site meter is
internal only, with debug comparison when all readings are valid. Other smart-plug
meters can overlap whole-home load. No cumulative energy is published in `net-grid`.
Native SOC metadata is verified in the endpoint; its Apple details UI is not
confirmed by the wattage screenshot.

Only use a clean pairing as recovery for missing readings: it affects every
accessory on the main bridge, and rooms/automations may need to be recreated.
Routine upgrades do not reset pairing. The package default remains the load-only
`home-consumption` profile; `net-grid` explicitly overrides legacy meter selections.

The plugin preserves pairing storage during upgrades. Remove stale Home entries
before pairing again. Home controls room prompts and can retain user-assigned names.
Homebridge's UI may need a reload or restart after new names are persisted. During
startup or proxy outages its tiles can briefly display placeholder states: confirm
live telemetry before treating those tiles as current sensor readings.

## Reproduction and verification

From `homebridge/`: run `npm ci --ignore-scripts`, `npm test`, `npm run check`, and
`npm pack`. From the repository root run `pytest -m "not live" --no-cov`.
Install the generated tarball in Homebridge's package directory and restart.
No npm registry publication is part of this release.

The tagged source and packaged archive identify the definitive release; earlier
HAP and grouped Matter branches remain historical references.
