"use strict";

const { NewsEventStore } = require("../lib/newsEventStore");

const store = new NewsEventStore();
try {
  console.log(JSON.stringify(store.repairEventIdsToCanonicalKeys(), null, 2));
} finally {
  store.close();
}