"use strict";

// Shared, metadata-only concrete-event evidence. Stage A uses hasConcreteEvent
// to decide whether stock/investor wrapper noise may be ignored; causality uses
// the narrower production-expansion and supply-decrease fields below.
const PRODUCTION_EXPANSION_PATTERN = /\b(commercial production|full(?:\s+\w+){0,2}\s+production|production starts?|production increase|ramp[ -]?up|mine restart|mine reopening|output increase|produktionsstart|produktionssteigerung|produktionshochlauf|hochlauf|förderbeginn|förderung steigt|wiedereröffnung|mine wiedereröffnet)\b/i;
const PRODUCTION_MENTION_PATTERN = /\b(production|output|produktion|förderung)\b/i;
const SUPPLY_DECREASE_PATTERN = /\b(mine clos(?:e|es|ed|ure)|mine shutdown|production shutdown|production cut|output reduction|export controls?|export restrictions?|export licen[cs]e(?:s)?|export ban|export quota|minenschließung|produktionsstopp|produktionskürzung|förderrückgang|exportbeschränkung|exportkontrolle|ausfuhrbeschränkung|ausfuhrverbot)\b/i;
const CHINA_EXPORT_PATTERN = /\b(?:china|chinese).{0,60}\btungsten exports?\b/i;
const MATERIAL_COMMERCIAL_CHANGE_PATTERN = /\b(?:material |additional )?(?:procurement|offtake)\b[^.\n]{0,50}\b(change|increase|volume|order|purchase|purchasing)\b|\b(?:change|increase|volume|order|purchase|purchasing)\b[^.\n]{0,50}\b(?:procurement|offtake)\b/i;

function asText(value) {
  return String(value || "").toLowerCase();
}

function detectConcreteMarketEvent(value) {
  const text = asText(value);
  const productionExpansion = PRODUCTION_EXPANSION_PATTERN.test(text);
  const productionMention = PRODUCTION_MENTION_PATTERN.test(text);
  const supplyDecrease = SUPPLY_DECREASE_PATTERN.test(text) || CHINA_EXPORT_PATTERN.test(text);
  const materialCommercialChange = MATERIAL_COMMERCIAL_CHANGE_PATTERN.test(text);
  return {
    productionExpansion,
    productionMention,
    supplyDecrease,
    materialCommercialChange,
    hasConcreteEvent: productionExpansion || productionMention || supplyDecrease || materialCommercialChange,
  };
}

module.exports = { detectConcreteMarketEvent };
