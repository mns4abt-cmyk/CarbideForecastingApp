"use strict";

const { collectEventOutcomeDiagnostics } = require("../lib/eventOutcomeDiagnostics");

function main() {
  console.log(JSON.stringify(collectEventOutcomeDiagnostics(), null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("Event outcome diagnostic failed:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
