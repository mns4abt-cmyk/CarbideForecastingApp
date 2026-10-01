"use strict";

// News-Lage v2 only. This intentionally does not share the 14-day decay used
// by lib/newsSignals.js or any Evidence Fusion calculation.
const NEWS_LAGE_V2_HALF_LIFE_DAYS = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function validTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

// Uses the same event-time precedence as NewsEventStore#getRecentEvents:
// publishedAt describes when the event occurred; firstSeenAt is a fallback
// only when publication time is absent or invalid.
function eventTime(event) {
  const publishedTime = validTime(event?.publishedAt);
  return publishedTime ?? validTime(event?.firstSeenAt);
}

/**
 * Deterministic News-Lage v2 event freshness.
 *
 * weight = 0.5 ^ (max(0, ageDays) / 10)
 *
 * `referenceTime` is explicit so the function has no clock or I/O dependency.
 * An invalid event timestamp or reference timestamp returns zero, ensuring bad
 * stored data cannot contribute. Future event timestamps are treated as age 0.
 */
function freshnessWeight(event, referenceTime, halfLifeDays = NEWS_LAGE_V2_HALF_LIFE_DAYS) {
  const timestamp = eventTime(event);
  const reference = validTime(referenceTime);
  if (timestamp === null || reference === null) return 0;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0;
  const ageDays = Math.max(0, (reference - timestamp) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

module.exports = {
  NEWS_LAGE_V2_HALF_LIFE_DAYS,
  eventTime,
  freshnessWeight,
};
