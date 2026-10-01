"use strict";

const { collectNewsLageDiagnostics, reportHasFailures } = require("../lib/newsLageDiagnostics");

function printableMarket(market) {
  const { events, ...report } = market;
  return report;
}

function main() {
  const report = collectNewsLageDiagnostics();
  console.log(JSON.stringify({
    ...report,
    china: printableMarket(report.china),
    eu: printableMarket(report.eu),
  }, null, 2));
  if (reportHasFailures(report)) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("News-Lage diagnostic failed:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { main, printableMarket };
