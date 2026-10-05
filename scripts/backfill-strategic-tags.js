"use strict";

const { backfillStrategicTags } = require("../lib/strategicMarketTagPersistence");
const result = backfillStrategicTags();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
