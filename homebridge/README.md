# homebridge-powerwall-meters

Homebridge Matter plugin using the existing pypowerwall HTTP proxy.
Exposes **home consumption** by default, battery status, two configurable battery
limit contacts, and optional policy controls. Other raw meters are opt-in.
No inferred solar-to-home allocation. Existing Python APIs are preserved; proxy t102 adds a separate Homebridge policy surface.

**Current definitive version: v0.7.1**, tagged `homebridge-v0.7.1`.
The opt-in signed grid-balance profile is verified in Apple Home on homescreen.
See [release notes](RELEASE.md) and the [current homescreen deployment](docs/DEFINITIVE_RELEASE.md).
Read the [research and delivery plan](docs/APPLE_HOME_RESEARCH.md) before choosing meter presentation.

## Installation — Matter v0.7.1

Requires Homebridge 2.4+, Node 22/24/26 and pypowerwall proxy t102 for controls.
Build with `npm ci --ignore-scripts`, `npm test`, and `npm pack` in this directory.
Install `homebridge-powerwall-meters-0.7.1.tgz` in your Homebridge plugin directory,
enable Matter on the main bridge, then restart. Use the welcome-screen Matter QR.
The plugin publishes no HAP accessories. It registers individually named Matter
accessories, then retires its old composed group and legacy threshold accessories.
Bridge pairing storage is kept. Apple Home can require room assignment for each
accessory again; the group layout and its automations do not transfer automatically.

Each accessory supplies its own NodeLabel at pairing, rather than relying on
semantic labels on composed children that Apple Home ignores. Only home load
publishes electrical measurement in the default profile. Each accessory has
independent reachability. Battery percentage remains a native Matter PowerSource
attribute; Homebridge UI may not render it as a battery tile.

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

The battery status accessory is named **Low Battery Warning**.
`thresholdSensors` defaults to true and creates exactly two battery limit contacts:

- **Above 90 Percent**: `aboveLimitPercent`, default 90; opens when charge is above the limit.
- **Below 70 Percent**: `belowLimitPercent`, default 70; opens when charge is below the limit.

Configure these independently from 0 to 100 in Homebridge plugin settings, then
restart. Names reflect the configured limits; identities remain unchanged when limits change. The old
`thresholdValues` array is ignored. Below Backup Reserve, Grid Disconnected, and
Scheduled Backup have been removed from the plugin. Legacy settings cannot re-enable them.
Limits are Homebridge configuration values, not writable controls in Apple Home.

A contact **opens when its condition becomes active**. Comparisons are strict:
charge equal to the limit does not initially activate it. `thresholdHysteresis`
defaults to 2 percentage points and affects clearing only: Above 90 clears at 88
or lower; Below 70 clears at 72 or higher. Set it to 0 to remove this latch. Reset
boundaries are clamped to 0–100. Missing charge makes the contacts unavailable;
recovery evaluates the current value without retaining a stale latch. An above
limit of 100 or below limit of 0 can never activate because comparisons are strict.

Optional controls (all off by default):

| Configuration | Home wording and meaning |
|---|---|
| `energyExportSwitches: true` | Export Solar Only / Export Battery & Solar, mutually exclusive selections |
| `noExportSwitch: true` | Adds Energy Exports No Export (`never`), **not** Permission to Export |
| `gridChargingSwitch: true` | Grid Charging on = Yes, off = No; permission, not current activity |
| `operationalModeSwitches: true` | Self Powered Operating Mode / Savings Operating Mode; `savingsLabel` may be Time-Based Control |
| `backupReservePresets: [10,20]` | 10 Percent Backup / 20 Percent Backup, configurable integer presets |
| `advancedGridControls: true` | Go Off-Grid / Reconnect to Grid, momentary commands that physically operate the contactor |

Backup Reserve sets retained capacity, not a charging target. Choice switches reject
turning the selected option off: select another option instead. Momentary grid
commands reset on the next poll; acknowledgement does not prove physical completion.
Confirm actual grid status in the Tesla app. Unsupported/unknown state is unavailable,
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

All production accessories use the main Homebridge Matter bridge. There are no
separate meter pairing codes. See the migration notes below before resetting a pairing.

## Signed grid-balance profile (v0.7.0)

Set `meterProfile: "net-grid"` to expose three read-only metered outlets:
Home consumption (+usage), Solar generation (−generation), and Battery
(+charging, −discharging). Their signed sum estimates net grid import (+) or
export (−). The actual site meter is read internally for comparison but never
published in this profile. Debug logs show inferred/measured grid power and their
difference when all four readings are valid. Timing and meter boundaries may
produce differences; no balancing adjustment is fabricated.

This profile overrides legacy meter/outlet/energy selections, disables cumulative
energy reporting, and keeps all three outlets on. Solar/battery use new identities
to avoid reusing historical readings with opposite signs. Battery charge status
continues to use the original raw gateway convention. Missing readings remain
unavailable, not zero. The prior `home-consumption` profile remains the default
and can be selected to roll back. Other metered devices in Home still overlap
with whole-home consumption. Individual signed wattages and room aggregation were
observed in Apple Home on 21 September 2026; other controller versions may differ.

homescreen was changed to this profile on 21 September 2026; its 65/90 percent
contacts and existing policy controls are retained. The v0.6.3 tagged release
remains available as the previous definitive release.

In `net-grid`, native battery percentage and charging status belong to the Battery
meter. Low Battery Warning remains a separate contact without duplicated battery
metadata. Apple Home decides where and whether to display those attributes.

### Verified Apple Home setup and upgrades (v0.7.1)

After a clean pairing using the **main Homebridge welcome-screen Matter QR**, all
three tiles displayed power: Home consumption +1.40 kW, Solar generation −6.19 kW,
and Battery +13 W. The room showed −4.77 kW. Display rounding and asynchronous
updates mean screenshots are not an exact same-sample balance check.

During upgrades, Apple Home initially included Solar and Battery in room totals
but omitted their individual Power rows and tile readings. Recreating just those
endpoints did not resolve it. Removing the old bridge from Apple Home, clearing
its Matter pairing in Homebridge, and pairing the main bridge again resolved the
observed issue. This is consistent with stale discovery/association state; Apple's
internal cause has not been established. Negative values themselves are supported.

Use this recovery only if individual meter readings remain absent after upgrading:
record room assignments and affected automations, remove the main Homebridge
Matter bridge from Apple Home, reset that bridge's Matter pairing in Homebridge,
then pair using the welcome-screen Matter QR and restore assignments/automations.
This affects every accessory on that bridge. Normal upgrades preserve pairing and
do not require a reset. There is no periodic name refresh or standalone meter bridge.
Native battery percentage/charging metadata is attached to Battery, but the latest
visual verification covers watts, not Apple's battery-details UI or energy history.
