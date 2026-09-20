# Release notes

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
