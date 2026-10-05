"use strict";

function deriveClassificationStatus({ providerAvailable, selectedCount, classifiedCount, failedBatches }) {
  if (!selectedCount) return "no_input";
  if (!failedBatches && classifiedCount === selectedCount) return "success";
  if (classifiedCount) return "partial";
  return providerAvailable ? "failed" : "unavailable";
}

module.exports = { deriveClassificationStatus };
