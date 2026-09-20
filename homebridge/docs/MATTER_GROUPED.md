# Grouped Matter v0.5.0

HAP v0.4.2 is saved at commit 03d42a7 on codex/powerwall-hap-only.
The independent-endpoint Matter release remains on codex/powerwall-matter-0.2.13.
This version is on codex/powerwall-matter-grouped.

The root is one Powerwall OnOffOutlet with native electrical power measurement.
It is always on and rejects control writes. 33 configured child endpoints carry
battery status, threshold contacts and policy controls. Default configuration
publishes electrical power only on the root, avoiding overlapping meter totals.
Children use stable IDs and semantic labels. Controller room/naming behavior must
be checked on the user's Apple Home device; composition alone cannot dictate UI.

Root reachability is conservative: all enabled functions must be available.
Child functional endpoints do not carry independent BridgedDeviceBasicInformation.
No stale reading is deliberately replaced with a plausible zero.

homescreen.local config backup:
/var/lib/homebridge/config.json.before-grouped-matter-1789889702
Matter is enabled on main bridge UDP 5530. HAP accessory cache is empty; HAP pairing
identity is preserved. Pair using the main welcome-screen Matter QR. No Tesla
control writes are issued during migration or validation. Earlier pairing resets
were user-requested; this migration does not clear protocol storage.

Verified deployment on 20 September 2026: one cached Matter accessory with 33
parts, one electrical measurement endpoint, and zero HAP accessories. A second
restart restored the composed device without startup errors. Live dashboard
reported Powerwall On at 701.3 W, with updating child sensor/control states.
Main Matter identity is uncommissioned and ready for user pairing. Homebridge UI
prefixes child display labels with the parent name; actual child labels are short.
28 Node tests and 647 non-live Python tests passed.
