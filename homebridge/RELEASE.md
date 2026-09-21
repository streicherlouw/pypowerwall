# Release notes

## v0.7.1 — Verified signed Matter meters (21 September 2026)

Definitive release for the homescreen deployment, using the main Homebridge
welcome-screen Matter pairing and 13 individually named accessories.

- Opt-in `net-grid` presents Home consumption as positive usage, Solar generation
  as negative generation, and Battery as positive charging / negative discharge.
  Their sum estimates grid import/export; the measured site meter remains internal.
- Native battery percentage and charging metadata move to the Battery meter in
  this profile. Low Battery Warning stays a separate contact.
- Solar and Battery receive fresh net-grid identities with Electrical Sensor and
  battery Power Source utility types present in the initial Descriptor.
- All meter outlets remain on and read-only. No cumulative energy is synthesized.
  The default remains `home-consumption`; controls and threshold behavior are unchanged.
- Document the successful clean-main-bridge-pairing recovery for missing individual
  Power rows. Endpoint recreation alone did not fix the observed Apple Home cache
  behavior. No separate pairing, background name refresh, or automatic pairing reset.

User verification on 21 September: all three Apple Home tiles display signed power
and contribute to the room total. Native battery-details UI and energy history are
not established by this check. See docs/DEFINITIVE_RELEASE.md for deployment settings.

Validation: 32 Node tests and 647 non-live Python tests; JavaScript syntax checks.

## v0.7.0 — Signed grid balance (21 September 2026)

Adds opt-in `net-grid`: three signed metered outlets for load, solar and battery;
the measured grid is internal only. Raw solar and battery signs are reversed for
Matter import/export convention. No cumulative energy is published in this profile.
The existing load-only default and control behavior are preserved. Apple Home
negative-value aggregation requires controller-side validation.

## v0.6.3 — Definitive Matter release (20 September 2026)

This release replaces the composed Powerwall accessory with independently named
Matter accessories. Each endpoint supplies its name through
BridgedDeviceBasicInformation.NodeLabel at pairing. This avoids relying on child
semantic labels that Apple Home ignored in the grouped implementation. Apple Home
may still ask for a room for each accessory.

- Expose only home consumption power by default, avoiding double-counting overlapping
  Powerwall meters. The metered outlet always reports on and rejects control writes.
- Replace the 22 fixed battery thresholds with two configurable contacts. Names
  reflect the actual limits; identities remain stable when the limits change.
- Use strict above/below comparisons with configurable clearing hysteresis.
  Package defaults are above 90 and below 70 percent; the definitive homescreen
  configuration explicitly sets above 90 and below 65 percent.
- Preserve native Matter battery percentage and the Low Battery Warning contact.
- Preserve export, operating-mode, backup-reserve and grid-charging controls.
- Remove Below Backup Reserve, Grid Disconnected and Scheduled Backup from the
  plugin implementation and settings. Existing Python/proxy APIs remain compatible.
- Retire old plugin accessories during migration without clearing bridge pairings.
  No Tesla setting is changed by installation or polling.

Validation: 29 Node tests and 647 non-live Python tests pass. Tests cover initial
pairing labels, stable identities, cache cleanup, strict comparisons, hysteresis,
unavailable readings, and both contacts closed at 75 percent. homescreen runs
v0.6.3 with 11 accessories; live readings and control states have been observed
in the dashboard. Actual Apple Home commissioning remains a user-side check.

Install the release archive with Homebridge 2.4+ and Node 22/24/26. See README.md
for configuration and docs/DEFINITIVE_RELEASE.md for the selected deployment.
