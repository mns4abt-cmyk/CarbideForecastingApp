"use strict";

// These column names are the stable output of
// forecasting/load_data.py#load_weekly_market_data. This module deliberately
// consumes that already cleaned, Friday-ending series and never reads/parses
// the Excel workbooks itself.
const MARKET_SERIES = Object.freeze({
  china: Object.freeze({ column: "china_cny_kg", unit: "CNY/kg APT" }),
  eu: Object.freeze({ column: "eu_usd_mtu", unit: "USD/mtu WO3" }),
});
const FORWARD_HORIZON_WEEKS = Object.freeze([1, 4, 12, 26]);
// W-FRI observations can be up to six calendar days after an arbitrary event
// weekday. Seven days also permits the next normalized week after a missing
// Friday observation, without letting the match drift beyond one week.
const FORWARD_MATCH_TOLERANCE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toValidDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(value) {
  const date = toValidDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function utcDateTime(isoDay, endOfDay = false) {
  return new Date(`${isoDay}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`).getTime();
}

function addWeeks(isoDay, weeks) {
  return new Date(utcDateTime(isoDay) + weeks * 7 * MS_PER_DAY).toISOString().slice(0, 10);
}

function unavailableAssociation(market, eventDate, unit, reason) {
  return {
    market,
    eventDate,
    matchedPriceDate: null,
    priceAtEvent: null,
    unit,
    available: false,
    reason,
  };
}

/**
 * Finds the latest actual normalized weekly price at or before an event date.
 *
 * `weeklySeries` must be the array form of the existing Python loader's
 * `load_weekly_market_data()` result, for example:
 * [{ week: "2026-09-04", china_cny_kg: 100, eu_usd_mtu: 310 }].
 * Missing weekly observations (null/NaN) are skipped. The comparison is
 * inclusive and rejects every price dated after the event.
 */
function associateEventPrice({ market, eventDate, weeklySeries } = {}) {
  const definition = MARKET_SERIES[market];
  if (!definition) throw new RangeError("market must be one of: china, eu");

  const normalizedEventDate = isoDate(eventDate);
  if (!normalizedEventDate) {
    return unavailableAssociation(market, null, definition.unit, "invalid_event_date");
  }
  const eventTime = new Date(`${normalizedEventDate}T23:59:59.999Z`).getTime();
  const rows = Array.isArray(weeklySeries) ? weeklySeries : [];
  let matched = null;

  for (const row of rows) {
    const priceDate = isoDate(row?.week);
    const price = Number(row?.[definition.column]);
    if (!priceDate || !Number.isFinite(price) || price <= 0) continue;
    const priceTime = new Date(`${priceDate}T00:00:00.000Z`).getTime();
    if (priceTime > eventTime) continue;
    if (!matched || priceTime > matched.time) {
      matched = { time: priceTime, date: priceDate, price };
    }
  }

  if (!matched) {
    return unavailableAssociation(market, normalizedEventDate, definition.unit, "no_historical_price");
  }
  return {
    market,
    eventDate: normalizedEventDate,
    matchedPriceDate: matched.date,
    priceAtEvent: matched.price,
    unit: definition.unit,
    available: true,
    reason: null,
  };
}

function unavailableOutcome(horizonWeeks, targetDate, reason, status = "unavailable") {
  return {
    horizonWeeks,
    targetDate,
    matchedPriceDate: null,
    futurePrice: null,
    returnPct: null,
    available: false,
    status,
    reason,
  };
}

function requestedHorizons(value) {
  const horizons = Array.isArray(value) ? value : FORWARD_HORIZON_WEEKS;
  const selected = [...new Set(horizons.filter((horizonWeeks) => FORWARD_HORIZON_WEEKS.includes(horizonWeeks)))];
  if (!selected.length) throw new RangeError("horizons must contain one or more supported horizon weeks");
  return selected.sort((left, right) => left - right);
}

function firstPriceOnOrAfter(rows, column, targetTime, latestAllowedTime) {
  let matched = null;
  for (const row of rows) {
    const priceDate = isoDate(row?.week);
    const price = Number(row?.[column]);
    if (!priceDate || !Number.isFinite(price) || price <= 0) continue;
    const priceTime = utcDateTime(priceDate);
    if (priceTime < targetTime || priceTime > latestAllowedTime) continue;
    if (!matched || priceTime < matched.time) matched = { time: priceTime, date: priceDate, price };
  }
  return matched;
}

/**
 * Associates an event with the same normalized series used by
 * `associateEventPrice`, then calculates realized forward returns.
 *
 * `referenceDate` is deliberately required and explicit: this keeps the
 * operation pure and prevents a test or historical replay from silently using
 * prices beyond its as-of date. A horizon whose target date is later than that
 * reference is `pending`; an elapsed target without a valid price in the
 * documented seven-day tolerance is `unavailable`.
 */
function associateEventPriceOutcomes({ market, eventDate, weeklySeries, referenceDate, horizons } = {}) {
  const definition = MARKET_SERIES[market];
  if (!definition) throw new RangeError("market must be one of: china, eu");
  const normalizedEventDate = isoDate(eventDate);
  if (!normalizedEventDate) {
    return { ...associateEventPrice({ market, eventDate, weeklySeries }), outcomes: [] };
  }
  const normalizedReferenceDate = isoDate(referenceDate);
  if (!normalizedReferenceDate) throw new RangeError("referenceDate must be a valid date");

  const association = associateEventPrice({ market, eventDate: normalizedEventDate, weeklySeries });
  const rows = Array.isArray(weeklySeries) ? weeklySeries : [];
  const referenceTime = utcDateTime(normalizedReferenceDate, true);
  const outcomes = requestedHorizons(horizons).map((horizonWeeks) => {
    const targetDate = addWeeks(normalizedEventDate, horizonWeeks);
    const targetTime = utcDateTime(targetDate);
    if (!association.available) {
      return unavailableOutcome(horizonWeeks, targetDate, "price_at_event_unavailable");
    }
    if (targetTime > referenceTime) {
      return unavailableOutcome(horizonWeeks, targetDate, "target_date_not_reached", "pending");
    }
    const matched = firstPriceOnOrAfter(
      rows,
      definition.column,
      targetTime,
      Math.min(targetTime + FORWARD_MATCH_TOLERANCE_DAYS * MS_PER_DAY, referenceTime)
    );
    if (!matched) return unavailableOutcome(horizonWeeks, targetDate, "no_price_within_tolerance");
    return {
      horizonWeeks,
      targetDate,
      matchedPriceDate: matched.date,
      futurePrice: matched.price,
      returnPct: ((matched.price / association.priceAtEvent) - 1) * 100,
      available: true,
      status: "available",
      reason: null,
    };
  });

  return { ...association, outcomes };
}

module.exports = {
  MARKET_SERIES,
  FORWARD_HORIZON_WEEKS,
  FORWARD_MATCH_TOLERANCE_DAYS,
  requestedHorizons,
  associateEventPrice,
  associateEventPriceOutcomes,
};
