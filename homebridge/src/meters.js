'use strict';

/**
 * Raw Powerwall meter validation and Matter unit conversion.
 * Author: Jason A. Cox
 * https://github.com/jasonacox/pypowerwall
 * Functions: meterReading, energyReading, stateOfCharge.
 */

const CHANNELS = ['load', 'solar', 'site', 'battery'];
const LABELS = { load: 'Home consumption', solar: 'Solar generation', site: 'Grid', battery: 'Battery' };
const finite = value => typeof value === 'number' && Number.isFinite(value);

// Preserve the gateway meter orientation. In particular, battery discharge and
// solar generation are positive in these raw meters; grid import is positive.
// These are separate meters, not additive appliances or inferred flow edges.
function meterReading(payload, channel, now, staleAfterMs, requireTimestamp = true) {
  const data = payload?.[channel];
  if (!data || !finite(data.instant_power)) throw new Error(`Missing ${channel} meter`);
  const timestamp = Date.parse(data.last_communication_time);
  if ((requireTimestamp && !Number.isFinite(timestamp)) ||
      (Number.isFinite(timestamp) && (now - timestamp > staleAfterMs || timestamp - now > 60000))) {
    throw new Error(`Stale ${channel} meter`);
  }
  const activePower = Math.round(data.instant_power * 1000);
  if (!Number.isSafeInteger(activePower)) throw new Error(`Invalid ${channel} meter range`);
  return { activePower };
}

function energyReading(payload, channel) {
  const data = payload?.[channel];
  const result = {};
  for (const [source, target] of [
    ['energy_imported', 'cumulativeEnergyImported'],
    ['energy_exported', 'cumulativeEnergyExported'],
  ]) {
    const value = data?.[source];
    const energy = Math.round(value * 1000); // Gateway Wh -> Matter mWh.
    result[target] = finite(value) && value >= 0 && Number.isSafeInteger(energy) ? { energy } : null;
  }
  return result;
}

function stateOfCharge(payload) {
  if (!finite(payload?.percentage) || payload.percentage < 0 || payload.percentage > 100) {
    throw new Error('Missing or invalid battery percentage');
  }
  return payload.percentage;
}

module.exports = { CHANNELS, LABELS, finite, meterReading, energyReading, stateOfCharge };
