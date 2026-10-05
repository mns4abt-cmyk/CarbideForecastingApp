"use strict";
const { collectStrategicIntelligenceDiagnostics } = require("../lib/strategicIntelligenceDiagnostics");

function main() {
  const report = collectStrategicIntelligenceDiagnostics();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "available") process.exitCode = 1;
}
if (require.main === module) main();
module.exports = { main };
