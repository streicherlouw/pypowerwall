# Powerwall → Apple Home: research and implementation plan

Research date: **19 September 2026**. Scope: measured Powerwall meter channels,
state of charge, and configurable controls. Solar-to-home attribution was explicitly
excluded. The implementation is in the adjacent package; the matrix below separates
working code from controller UI claims that require physical testing.

## Findings and evidence quality

**Use Homebridge's Matter transport for energy.** Its released API includes
ElectricalPowerMeasurement and ElectricalEnergyMeasurement. The package targets
Homebridge 2.4.0 and uses the public registration/update methods. Homebridge's
[API documentation](https://developers.homebridge.io/homebridge/interfaces/MatterAPI.html)
describes Matter as opt-in per bridge. The [release history](https://github.com/homebridge/homebridge/blob/latest/CHANGELOG.md)
records energy-cluster support and subsequent reliability changes. We inspected
the installed 2.4.0 implementation, not just development-branch examples.

**Apple's SDK, Matter specification and Home app are different compatibility layers.**
An SDK exposing a cluster does not guarantee a Home tile, historical chart,
automation trigger or flow diagram. Apple's [Matter overview](https://developer.apple.com/apple-home/matter/)
explains ecosystem integration, but does not promise every Matter device type's
UI. The [Matter framework reference](https://developer.apple.com/documentation/Matter)
contains energy-management interfaces; their existence alone is insufficient
evidence of a Powerwall-like Home dashboard.

**Firsthand implementation evidence supports outlet wattage, with bridge limitations.**
The maintainer of [homebridge-shelly-matter](https://github.com/keremerkan/homebridge-shelly-matter#apple-home-behaviours)
reports iOS/tvOS 27 energy display, wattage on outlet-typed tiles, and no individual
Energy breakdown entries for bridged accessories despite inclusion in the home total.
Their testing compared bridged and standalone endpoints and did not attribute the
difference to certification. This is a primary implementer's report, **not our own
validation or an Apple guarantee**. Treat behaviour as OS-build-dependent. We found
no equivalent direct validation for macOS 27, nor a guarantee for signed production
readings, ElectricalSensor-only devices or home-storage flow diagrams.

**EnergyKit is not the telemetry-ingestion route.** Apple's
[EnergyKit overview](https://developer.apple.com/energykit/) and
[WWDC session](https://developer.apple.com/videos/play/wwdc2025/257/)
describe electricity-guided operation for EV charging and thermostats. This does
not establish a public API for uploading arbitrary Powerwall meters into Home's
native Energy dashboard. A Swift companion app could provide its own UI, but it
would be a separate product, not a Homebridge plugin feature.

**Utility-account energy is separate.** Apple's
[iOS 27 electricity guide](https://support.apple.com/guide/iphone/view-electricity-usage-and-rates-iphb93a7973e/27/ios/27)
documents participating U.S. utility accounts, including import/export history,
typically delayed 24–72 hours. A local plugin cannot present itself as one of those
providers through a documented public upload API. Do not make an Australian
Powerwall installation depend on U.S. utility-account support.

**Matter supports more than the verified Home UI.** The CSA's
[Matter 1.4 announcement](https://csa-iot.org/newsroom/matter-1-4-enables-more-capable-smart-homes/)
adds solar and battery-storage device types. Those are useful future protocol
targets. They do not establish Apple Home rendering support, and Homebridge 2.4's
public device-type table does not offer SolarPower or BatteryStorage constructors.
Using a generic meter is implementable now; claiming native storage UI would be premature.

## Capability matrix

| Information/control | Implemented mapping | Apple Home expectation and limit |
|---|---|---|
| Home/load watts | Matter activePower; default read-only outlet | Best-supported reported wattage presentation; overlaps downstream smart plugs |
| Solar watts | Raw meter, ElectricalSensor by default; optional outlet | Generic sensor may be hidden; an outlet label does not make it a solar-source node |
| Grid import/export watts | One signed site meter | Positive import, negative export; negative-value UI needs testing |
| Battery charge/discharge watts | One signed battery meter | Positive discharge, negative charging; no claim of storage-flow UI |
| Imported/exported energy | Optional native cumulative counters on each meter | Protocol publishes mWh; Home history/breakdown is controller-dependent |
| Battery percentage | PowerSource.batPercentRemaining on low-battery contact | Standard percentage data; details UI unverified, no percentage tile promised |
| Low battery | Contact + PowerSource low level | Binary contact presentation can support threshold automations; validate open/closed semantics |
| Allow battery export | Opt-in on/off policy control | Outlet-backed toggle; permits `battery_ok`, not forced discharge |
| Allow grid charging | Opt-in on/off policy control | Existing proxy's failure-to-false ambiguity remains |
| Voltage/current | Candidate optional measurement attributes | Matter can carry mV/mA; not yet implemented; validate real vs stub values and phase aggregation first |
| Grid connection/outage | Candidate contact sensor | Useful next addition; use grid-status enum, never infer outage from zero watts |
| Reserve / operating mode | Candidate preset controls | No verified native energy-policy selector in Home; distinct presets preferable to fake dimmers |
| Per-pack health, temperatures, alerts | Candidate diagnostic sensors | Backend/hardware-dependent; battery chemistry temperatures are not room temperature |
| Solar-to-home allocation | Excluded | Raw meters only, per requested scope |

Apple documents a percentage-valued [HomeKit BatteryLevel characteristic](https://developer.apple.com/documentation/homekit/hmcharacteristictypebatterylevel).
That validates the concept of accessory battery status, not a dedicated household
battery dashboard. The implementation uses Matter half-percent units (`percent × 2`),
as defined by the installed Matter types, instead of inventing a humidity, temperature
or brightness reading to display a percentage.

## Options that are unavailable or not established

1. **Traditional HAP energy injection into the new native Energy UI:** no documented
   standard HAP watt/kWh mapping found in Apple's [characteristic list](https://developer.apple.com/documentation/homekit/characteristic-types).
   Custom Eve-style characteristics can serve compatible third-party apps but do
   not establish Apple Home energy support. A HAP fallback would not satisfy native energy.
2. **Custom dashboard inside Apple Home:** no documented extension point was found
   for plugin-defined charts, Sankey diagrams or a Tesla-style animated flow panel.
   A companion app/web dashboard can do this outside Home; a camera snapshot would
   merely be an image, not energy data or an automation source.
3. **Reliable per-device energy breakdown behind a bridge:** reported unavailable
   in the implementer's testing above. Keep this distinct from outlet tile wattage.
4. **Automatic household accounting from overlapping meters:** not defensible.
   Load, grid, solar and battery are related balance measurements, not independent
   consuming appliances. Do not sum them. Negative generation conventions and
   tree topology do not prove Home understands the house's electrical topology.
5. **Guaranteed history, export charts or watt-trigger automations:** not established
   for this plugin/controller combination. Publishing EEM counters does not create
   daily history automatically. Use explicit threshold contacts in a future release
   if Home lacks native watt triggers.
6. **Generic standalone Meter publishing through Homebridge 2.4:** some internal
   comments mention external publishing, but the inspected public MatterAPI does
   not provide a generic publishExternalAccessories method. Registration chooses
   external servers for particular device types. Do not call an undocumented method
   or impersonate a robot vacuum to obtain a standalone energy node.

For a stronger standalone/native-type experiment, investigate a separate matter.js
or [Matterbridge](https://github.com/Luligu/matterbridge) adapter. Matterbridge's
[device documentation](https://github.com/Luligu/matterbridge/blob/main/docs/README-DEV.html)
includes SolarPower and BatteryStorage. This requires a different deployment and
commissioning path; it still needs Apple compatibility testing. Keep the proxy client
and raw-meter normalization independent so they can be reused.

## Data contract and controls

Use `/api/meters/aggregates`, with one read producing the four channels. Preserve
signs and names from the proxy; watts become integer milliwatts, Wh become integer
milliwatt-hours. Never equate W with Wh or integrate gaps as continuous consumption.
Native energy counters require explicit operator verification because cloud/Fleet/
TEDAPI templates can contain zeros. TEDAPI can merge real local counters when
available. This initial package does not reconstruct missing energy or counter resets.

Use `/api/system_status/soe` for Tesla-app-scaled percentage. `/soe` has different
scaling in this repository. The plugin neither rescales the app value nor substitutes
zero for an error. Meter timestamps reject stale data; SOC and policy freshness
remain bounded by the proxy because their responses have no sample timestamps.

Policy writes use `/control/grid_export` and `/control/grid_charging`, with the
existing token-gated POST contract. The battery-export switch is read ON only for
`battery_ok`; OFF can represent `pv_only` or `never`. Repeated OFF preserves the
existing policy. ON→OFF uses an explicit configured policy. Reads and writes are
serialized, every write requires acknowledgement and readback, and timeout does
not trigger a blind retry. Disabled controls are never registered.

[Tesla's settings documentation](https://www.tesla.com/support/energy/powerwall/mobile-app/advanced-settings)
distinguishes solar-only export from exporting stored energy. Export permission,
reserve, time-of-use operation and site eligibility still govern actual behaviour.
Accordingly, the switch label is **Allow battery export**, not **Export now**.

## Delivery plan and acceptance gates

**Phase 1 — implemented, offline-validated:** standalone npm package in this repo;
config UI schema; raw meters; selectable outlet presentation; optional native energy;
battery percentage/threshold; opt-in policy toggles; timeout/error handling; stable
identities, cached-accessory reconciliation, non-overlapping polling; tests against
the released Homebridge feature builder. Python APIs remain untouched.

**Phase 2 — physical acceptance, required before calling this production-ready:**

| Test | Evidence to record |
|---|---|
| Commission a dedicated child bridge | Exact Homebridge, Node, iOS, macOS and hub builds; successful Matter pairing |
| Compare four meters to the same proxy snapshot | Units/signs at solar generation, grid import/export and battery charging/discharging |
| Compare sensor vs outlet presentation | Screenshots of each client; negative watts, Energy total and per-device breakdown |
| Battery at 0%, mid-range, 100% and low threshold | Percentage scaling; details visibility; contact automation transition |
| Native energy counters | Validate source authenticity, import/export orientation, display units, persistence/reset semantics |
| Export controls | `never`→OFF does not change policy; ON/OFF readback; verify Tesla app agrees |
| Proxy outage/stale timestamp/recovery | Unavailable indication, no fabricated zeros, no queued/retried writes |
| Restart and configuration changes | Identity survives, handlers restore, removed meters disappear, automations retained where identities match |
| macOS 27 specifically | Record independently; do not extrapolate iPhone UI results |

**Phase 3 — maximize confirmed data:** add verified voltage/current with explicit
phase semantics; grid-outage contact; configurable power/SoC thresholds with
hysteresis and minimum hold time; optional operating-mode/reserve presets without
changing public Python return shapes. Add additive proxy capability/freshness
metadata only if needed, with all repository documentation/version/test requirements.

**Phase 4 — resolve controller limitations:** compare a standalone Matter meter and
real solar/battery device types on a separate test fabric. Adopt only mappings whose
UI and accounting have been verified; preserve an opt-in compatibility mode for
outlet tiles. Publish the npm package only after physical acceptance and maintainer
release review. No live Powerwall settings were changed during this work.
