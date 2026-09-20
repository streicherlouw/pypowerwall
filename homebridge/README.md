# homebridge-powerwall-meters

Grouped Homebridge Matter plugin using the existing pypowerwall HTTP proxy.
Publishes the four **raw Powerwall meters**, battery percentage, and optional policy controls.
No inferred solar-to-home allocation. Existing Python APIs are preserved; proxy t102 adds a separate Homebridge policy surface.

**Apple Home grouping and pairing presentation require verification on the user’s device.**
Read the [research and delivery plan](docs/APPLE_HOME_RESEARCH.md) before choosing meter presentation.

## Installation — grouped Matter v0.5.0

Requires Homebridge 2.4+, Node 22/24/26 and pypowerwall proxy t102 for controls.
Build with `npm ci --ignore-scripts`, `npm test`, and `npm pack` in this directory.
Install `homebridge-powerwall-meters-0.5.0.tgz` in your Homebridge plugin directory,
enable Matter on the main bridge, then restart. Use the welcome-screen Matter QR.
The plugin publishes no HAP accessories. It retires its previous HAP accessories
when the grouped Matter registration is submitted; bridge pairing storage is kept.

This version registers one composed Powerwall accessory. Home consumption is its
root metered outlet; all other sensors and controls are child endpoints with stable
IDs and descriptive semantic labels. Only load publishes electrical measurement
in the default profile. This models one physical device, but Apple Home controls
room prompts, child naming and tiles; verify the result on your controller.
Matter does not share HAP's ConfiguredName characteristic or name-repair mechanism.

All child endpoints share root reachability. Any unavailable enabled function
marks the whole composed accessory unavailable, conservatively preventing stale
readings from looking healthy. The battery percentage remains a native Matter
PowerSource attribute; Homebridge UI may not render it as a battery tile.

Previous versions are preserved on `codex/powerwall-hap-only` (v0.4.2) and
`codex/powerwall-matter-0.2.13`. HAP rooms/automations cannot transfer to Matter.
No device pairing or protocol storage is automatically reset by this plugin.

Add this entry to `platforms`:

```json
{
  "platform": "PowerwallMeters",
  "name": "Powerwall",
  "siteId": "my-powerwall",
  "proxyUrl": "http://127.0.0.1:8675",
  "meterProfile": "home-consumption",
  "meters": ["load"],
  "outletMeters": ["load"],
  "nativeEnergyMeters": [],
  "batteryStatus": true,
  "lowBatteryPercent": 20,
  "pollSeconds": 15,
  "staleSeconds": 90
}
```

`siteId` is the stable accessory identity. Use a different ID for every site.
In a container, `127.0.0.1` refers to that container; set the reachable proxy address.

## Meter presentation

All selected meters publish `ElectricalPowerMeasurement.activePower`. By default
the load meter is an outlet for Apple Home wattage compatibility; other meters use
`ElectricalSensor`. Apple Home may not display those sensor endpoints. To try
visible tiles for all channels, set `outletMeters` to all four channel names.
This can distort Home's totals: the meters overlap, and generation is not appliance
consumption. Even the default home-load meter overlaps any existing smart-plug
meters in Home. Do not use Home's sum as an authoritative household energy balance.

Outlet meters are read-only: on, off and toggle commands return an error and never
disconnect power. Changing outlet presentation or native-energy capability creates a new accessory identity
for that meter; Home room assignments and automations may need updating.

| Channel | Positive power | Negative power |
|---|---|---|
| `load` | Home consumption | Preserved if supplied by gateway |
| `solar` | Solar generation | Preserved if supplied by gateway |
| `site` | Grid import | Grid export |
| `battery` | Battery discharge | Battery charging |

Native Wh counters are optional: populate `nativeEnergyMeters` only for channels
whose `energy_imported` and `energy_exported` fields are verified real counters.
Backend templates can contain synthetic zeroes. The plugin preserves raw counter
orientation, converts Wh to Matter mWh, and reports at most once per minute.
It does not integrate watts, manufacture history, stitch counter resets, or treat
daily-reset counters as lifetime totals. Confirm counter semantics for your backend.

Missing/stale meters become unavailable, with null power instead of zero.
`requireMeterTimestamp` defaults to true; disabling it permits timestamp-less
backends but cannot detect their cached stale samples. The SOC/control routes
have no source timestamps, so successful HTTP responses cannot prove freshness.
Polling is sequential, with one aggregate request per cycle and no overlapping cycles.
Cloud installations can increase `pollSeconds` to reduce API usage.

Battery percentage uses the already Tesla-app-scaled `/api/system_status/soe` route.
The low-battery contact is **open at or below the configured threshold**,
closed above it (Matter represents open as false and closed as true).
Charging state uses the battery meter with a 50 W noise threshold; unknown power
reports unknown charging state. Percentage is published on its Matter PowerSource cluster;
availability in Apple's details UI must be verified. It is not a battery-flow widget.

## Optional controls

Set `PW_CONTROL_SECRET` on the proxy. Supply the same secret to the Homebridge
process through an environment variable, then configure its **name**:

```json
{
  "allowBatteryExportSwitch": true,
  "exportOffPolicy": "pv_only",
  "gridChargingSwitch": false,
  "controlTokenEnv": "POWERWALL_CONTROL_TOKEN"
}
```

These fields extend the platform entry. Controls are outlet-backed on/off toggles
for Matter compatibility, labelled as policies; they carry no power measurements.

- **Allow battery export:** ON selects `battery_ok`. OFF, when previously ON,
  selects `pv_only` (default) or `never` (configured). OFF while already OFF leaves
  the existing non-battery policy unchanged. This permits export, not immediate
  forced discharge. Tesla/site/backend restrictions still apply.
- **Grid Charging:** ON/OFF sets the charging permission. This does not
  command a charge rate or override Tesla's scheduling.

Writes are serialized, require positive acknowledgement and matching readback,
and are never automatically retried. A readback mismatch reports failure even if
the write was accepted; subsequent polling reconciles state. No controls are
enabled by default, and startup/polling never issue writes.

Use a trusted LAN or authenticated network tunnel; the proxy token is sent in the
POST body, never the URL. HTTPS uses normal certificate validation. Redirects are
rejected. Secrets are not copied into accessory context or logged by this plugin.

## Validation

`npm test` covers readings, failures, policy transitions, restore/removal, and real
Homebridge 2.4 feature composition without starting a network server. `npm run check`
checks JavaScript syntax. See the research document for the outstanding physical
Apple Home acceptance matrix. This package is not Homebridge-verified or Matter-certified.

## Version 0.2 presentation and controls

Requires **proxy t102** for the new settings, reserve contact and grid status.
`meterProfile: "compact"` retains the four raw meters and their identities.
`"directional"` replaces the grid and battery meters with Grid Import, Grid Export,
Powerwall Charging and Powerwall Discharging. Each pair is the positive/negative
part of one meter, not an attribution of solar or battery power to a destination.
Directional channels do not publish cumulative counters; raw counters have different
orientations and cannot safely be split from instantaneous power. No synthetic kWh
history, energy-remaining-as-consumption, or estimated runtime is advertised to Home.
Apple Home has no supported custom flow-diagram extension in this plugin.

The battery child endpoint is named **Low Battery Warning**.
`thresholdSensors` defaults to true and creates **22 contact sensors**: Above and
Below each value in `thresholdValues`, default `[0,10,20,30,40,50,60,70,80,90,100]`.
A contact **opens when its named condition becomes active**. Configure Home
notifications and automations using "opens" for activation and "closes" for clearing.
Comparisons are strict: 50% initially activates neither Above 50% nor Below 50%.
`thresholdHysteresis` defaults to 2 percentage points: Above 50 activates above 50
and clears at or below 48; Below 50 clears at or above 52. Both can remain active
inside that band after a crossing; these are independent latched conditions.
Set hysteresis to 0 for mutually exclusive instantaneous conditions. Reset boundaries
are clamped to 0–100 so contacts can clear at physical endpoints. The configured
Below 0 and Above 100 slots retain their UUIDs but use thresholds/names of
**Below 1 Percent Battery** and **Above 99 Percent Battery**. With default hysteresis,
the former opens below 1% (including 0%) and clears at 3%; the latter opens above
99% (including 100%). Use Open for both empty- and full-battery automations.
Above 0 retains its original strict above-zero behavior. Missing SOC makes every threshold unavailable;
recovery evaluates the current value without retaining a stale latch.

Optional `belowReserveSensor` compares app-scaled charge against app-scaled Backup
Reserve with the same hysteresis. `gridStatusSensor` exposes Grid Disconnected from
actual grid status, never from zero watts. It does not claim that disconnection is
an outage: intentional islanding and utility loss may look identical in this API.

Optional controls (all off by default):

| Configuration | Home wording and meaning |
|---|---|
| `energyExportSwitches: true` | Energy Exports Solar / Everything, mutually exclusive selections |
| `noExportSwitch: true` | Adds Energy Exports No Export (`never`), **not** Permission to Export |
| `gridChargingSwitch: true` | Grid Charging on = Yes, off = No; permission, not current activity |
| `operationalModeSwitches: true` | Self-Powered / Savings; `savingsLabel` may be Time-Based Control |
| `backupReservePresets: [10,20]` | 10 Percent Backup / 20 Percent Backup, configurable integer presets |
| `scheduledBackupSwitch: true` | Scheduled Backup 2h; `scheduledBackupHours` selects 1–24 hours; off cancels |
| `advancedGridControls: true` | Go Off-Grid / Reconnect to Grid, momentary commands that physically operate the contactor |

Scheduled Backup is a manual event, not automatic weather-driven Storm Watch.
Backup Reserve sets retained capacity, not a charging target. Choice switches reject
turning the selected option off: select another option instead. Momentary grid
commands reset on the next poll; acknowledgement does not prove physical completion.
Watch Grid Disconnected for observed status. Unsupported/unknown state is unavailable,
not off. Enabling an operating-mode option is a site-owner configuration decision;
the gateway remains responsible for accepting that mode for the installation.

Set `controlAuthority: "homebridge"` to permit writes, or `"external"` to manually
make the plugin read-only. There is no external-automation conflict guard:
Homebridge and the display may both write settings, and subsequent writes may
replace earlier selections. Legacy `externallyManagedControls` is ignored.
Polling reflects the observed setting and never reasserts a desired policy.

`controlTokenFile` is an alternative to `controlTokenEnv`: an absolute path to a
private 0600 file, outside this repository, containing the proxy's control secret.
The new `/homebridge/state` route preserves null on failed policy reads and forces
configuration refresh; the legacy `/control/*` API remains unchanged. Commands use
the token-gated `/control/homebridge` route and require acknowledgement plus readback
(except momentary commands, which have no persistent setting to compare).


## 0.2.1: Apple Home consumption accounting

The default `meterProfile` is now `home-consumption`. Only the actual load meter
is exposed with electrical measurement clusters, even if an older `meters` array
selects all four. Solar/grid/battery remain available through the proxy, and the
battery meter still determines charging state. No fake zero or negative offsets
are used. SOC, thresholds and policy controls are unaffected. Compact/directional
profiles remain explicit diagnostic options; their overlapping readings distort
Apple Home totals. A separately metered smart plug within this whole-home load
can still be counted twice by Apple. Choose whole-home or individual-load reporting
rather than assuming Apple understands parent/child meter relationships.

Standalone publishing and native solar/battery role experiments are not enabled
in production: neither has yet demonstrated correct Apple aggregation. A clean
pairing requires removing the old Powerwall bridge in Apple Home and scanning the
new bridge's Matter QR code; old room assignments/automations do not migrate.
