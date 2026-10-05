"use strict";

// Calls the normal local refresh endpoint, so this diagnostic uses the same
// forecasting and news/event pipeline as the application. Start `npm start`
// first, then run `npm run diagnose:fusion` in another terminal.
const baseUrl = (process.env.MARKTRADAR_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const markets = ["china", "eu"];
const horizons = ["4", "12", "26"];
const { eventComponents, isDirectionalEvent } = require("../lib/evidenceFusion");

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(4) : "n/a";
}

function printDirectionalContributions(eventEvidence, market, horizonWeeks) {
  const contributions = (Array.isArray(eventEvidence) ? eventEvidence : [])
    .filter(isDirectionalEvent)
    .map((event) => ({ event, component: eventComponents(event, market, horizonWeeks) }))
    .filter(({ component }) => component.eventWeight > 0);

  console.log("directional event contributions:");
  if (!contributions.length) {
    console.log("- none");
    return;
  }
  for (const { event, component } of contributions) {
    console.log(`${event.eventId || "(missing eventId)"} | ${event.direction} | ${component.maturity}`);
    console.log(`  severity=${formatNumber(event.severity)} confidence=${formatNumber(event.confidence)}`);
    console.log(`  global=${formatNumber(event.globalRelevance)} china=${formatNumber(event.chinaRelevance)} eu=${formatNumber(event.euRelevance)}`);
    console.log(`  effectiveRelevance=${formatNumber(component.effectiveRelevance)}`);
    console.log(`  horizonWeight=${formatNumber(component.horizonWeight)}`);
    console.log(`  eventWeight=${formatNumber(component.eventWeight)}`);
  }
}

function printFusion(fusion, eventEvidence) {
  for (const market of markets) {
    for (const horizon of horizons) {
      const item = fusion?.[market]?.[horizon];
      console.log(`\n${market} · ${horizon} weeks`);
      if (!item || item.status === "unavailable") {
        console.log(`Fusion: unavailable (${item?.error || "missing output"})`);
        console.log("numericalAdjustmentApplied: false");
        continue;
      }
      const baseline = item.baselineEvidence;
      const news = item.newsEvidence;
      console.log(`baseline: direction=${baseline.direction}, forecastChangePct=${baseline.forecastChangePct}, reliability=${baseline.reliability}`);
      console.log(`news: direction=${news.direction}, signedBalance=${news.signedBalance}, strength=${news.strength}, extractionConfidence=${news.extractionConfidence}`);
      console.log(`counts: classified=${news.classifiedEvents}, directional=${news.directionalEvents}, neutral=${news.neutralEvents}, realized=${news.realizedDirectionalEvents}, prospective=${news.prospectiveDirectionalEvents}, speculative=${news.speculativeDirectionalEvents}`);
      console.log(`eventIds: ${news.eventIds.join(", ") || "none"}`);
      console.log(`agreement=${item.agreement}, corroboration=${item.corroboration}`);
      printDirectionalContributions(eventEvidence, market, Number(horizon));
      item.explanationReasons.forEach((reason) => console.log(`- ${reason}`));
      console.log(`numericalAdjustmentApplied: ${item.numericalAdjustmentApplied}`);
    }
  }
}

async function main() {
  let response;
  try {
    response = await fetch(`${baseUrl}/api/refresh`, { method: "POST" });
  } catch {
    throw new Error(`Could not reach ${baseUrl}. Start the app with npm start, then run npm run diagnose:fusion.`);
  }
  if (!response.ok) throw new Error(`Refresh failed with HTTP ${response.status}.`);
  const payload = await response.json();
  if (!payload?.ok) throw new Error(payload?.error || "Refresh returned no successful payload.");
  printFusion(payload.evidenceFusion, payload.eventEvidence);
}

main().catch((error) => {
  console.error("Fusion diagnostic failed:", error.message);
  process.exitCode = 1;
});
