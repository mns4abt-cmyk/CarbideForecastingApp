"use strict";

const { backfillEventOutcomes } = require("../lib/eventOutcomeBackfill");

async function main() {
  const diagnostics = await backfillEventOutcomes();
  console.log(JSON.stringify(diagnostics, null, 2));
  if (diagnostics.errors.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Event outcome backfill failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
