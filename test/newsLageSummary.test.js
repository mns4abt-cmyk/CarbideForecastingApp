"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNewsLageSummary, summarizeNewsLage } = require('../lib/newsLageSummary');
const event = { eventKey: 'a', title: 'Mine nimmt Wolframproduktion wieder auf', snippet: 'Die Verarbeitung wurde wieder aufgenommen.', source: 'Minenbericht', publishedAt: '2026-10-04', category: 'supply', direction: 'bearish', supplyEffect: 'increase', demandEffect: 'none', eventStage: 'actual', evidenceMaturity: 'realized', effectiveMarketRelevance: 0.8, finalWeight: 99, P50: 123 };
function fixture() {
  return { available: true, china: { sentimentScore: 42 }, eu: { sentimentScore: -42 }, events: { china: [event], eu: [{ ...event, eventKey: 'b', title: 'EU führt neue Exportregeln ein' }] }, managementSummary: { china: { status: 'available', topEvents: [event], text: 'old', additionalLlmCalls: false }, eu: { status: 'available', topEvents: [{ ...event, eventKey: 'b', title: 'EU führt neue Exportregeln ein' }], text: 'old', additionalLlmCalls: false } } };
}
const valid = 'The mine has resumed tungsten production. Processing operations have also restarted.';
test('fallback uses content and ignores aggregate scores', () => {
  const input = { topEvents: [event], sentimentScore: 42 };
  assert.match(buildNewsLageSummary(input), /Mine nimmt Wolframproduktion/);
  assert.equal(buildNewsLageSummary(input), buildNewsLageSummary({ ...input, sentimentScore: -99 }));
  assert.match(buildNewsLageSummary({ topEvents: [] }), /No selected/);
  for (const input of [null, {}, { topEvents: null }]) assert.match(buildNewsLageSummary(input), /No selected/);
});
test('separate selected event payloads are allowlisted; only summary metadata/text changes', async () => {
  const original = fixture();
  const before = structuredClone(original);
  const payloads = [];
  const result = await summarizeNewsLage(original, { fetch: async (url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ summary: valid }) } }) };
  } });
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0].messages.at(-1), { role: "assistant", content: "<think>\n\n</think>\n\n" });
  assert.match(payloads[0].messages[0].content, /Mine nimmt/);
  assert.doesNotMatch(payloads[0].messages[0].content, /EU führt/);
  assert.match(payloads[1].messages[0].content, /EU führt/);
  const sent = JSON.parse(payloads[0].messages[0].content.split('EVENTS:\n')[1].split('\n\n')[0]).events[0];
  assert.deepEqual(Object.keys(sent).sort(), ['title','snippet','source','publishedAt','category','direction','supplyEffect','demandEffect','eventStage','evidenceMaturity','marketRelevance'].sort());
  assert.equal(sent.supplyEffect, 'increase');
  assert.equal(result.managementSummary.china.text, valid);
  for (const market of ['china', 'eu']) {
    assert.equal(result.managementSummary[market].additionalLlmCalls, true);
    result.managementSummary[market].text = before.managementSummary[market].text;
    result.managementSummary[market].additionalLlmCalls = false;
  }
  assert.deepEqual(result, before);
  assert.deepEqual(original, before);
});
test('unavailable, malformed, technical, forecast and timed-out replies fall back independently', async () => {
  for (const reply of [null, JSON.stringify({ summary: 'The mine has resumed production. Prices will rise next month.' }), JSON.stringify({ summary: 'The mine has resumed production. This leads to higher supply.' }), JSON.stringify({ summary: 'The mine has resumed production. Market relevance is 0.8.' }), '{"summary":"Die Mine liefert Konzentrat. Die EU-Relevanz liegt bei 0,105."}', '{"summary":"Die Mine liefert Konzentrat. Diese Ereignisse führen zu einem Anstieg der Versorgung."}', '{}', '{"summary":""}', '{"summary":"finalWeight ist hoch. Der Preis wird steigen."}', '{"summary":"Die Mine hat die Produktion wieder aufgenommen. Die Verarbeitung läuft wieder."}']) {
    const result = await summarizeNewsLage(fixture(), { fetch: async () => {
      if (reply === null) throw Error('offline');
      return { ok: true, json: async () => ({ message: { content: reply } }) };
    } });
    assert.match(result.managementSummary.china.text, /Mine nimmt/);
    assert.match(result.managementSummary.eu.text, /EU führt/);
  }
  const result = await summarizeNewsLage(fixture(), { timeoutMs: 5, fetch: async () => new Promise(() => {}) });
  assert.match(result.managementSummary.china.text, /Mine nimmt/);
});
test('cache reuses validated output but invalidates changed content and model', async () => {
  const { NewsClassificationCache } = require('../lib/newsClassificationCache');
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-test-'));
  try {
    const cache = new NewsClassificationCache({ directory, model: 'local', schemaVersion: 'test' });
    let calls = 0;
    const options = { cache, fetch: async () => { calls++; return { ok: true, json: async () => ({ message: { content: JSON.stringify({ summary: valid }) } }) }; } };
    await summarizeNewsLage(fixture(), options);
    await summarizeNewsLage(fixture(), options);
    assert.equal(calls, 2);
    const changed = fixture(); changed.events.china[0] = { ...event, snippet: 'Neue Details' };
    await summarizeNewsLage(changed, options);
    assert.equal(calls, 3);
    await summarizeNewsLage(fixture(), { ...options, model: 'other' });
    assert.equal(calls, 5);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('one market failure does not suppress the other market; empty/unavailable never call Ollama', async () => {
  let calls = 0;
  const options = { fetch: async () => {
    if (++calls === 1) throw Error('offline');
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ summary: valid }) } }) };
  } };
  const result = await summarizeNewsLage(fixture(), options);
  assert.match(result.managementSummary.china.text, /Mine nimmt/);
  assert.equal(result.managementSummary.eu.text, valid);
  const unavailable = fixture(); unavailable.available = false;
  assert.deepEqual(await summarizeNewsLage(unavailable, options), unavailable);
  const empty = fixture();
  for (const market of ['china','eu']) empty.managementSummary[market].status = 'empty';
  assert.deepEqual(await summarizeNewsLage(empty, options), empty);
  assert.equal(calls, 2);
});

const headlineEvents = [
  { ...event, eventKey: 'h1', title: 'Tungsten Price Shock Signals Deeper Supply Crisis', source: 'Market News' },
  { ...event, eventKey: 'h2', title: 'Almonty Ends Legal Ambiguity in Ontario While Restarting Korean Tungsten Output', source: 'AD HOC NEWS' },
  { ...event, eventKey: 'h3', title: 'AWSX der Telegram-Trader.de: Almonty Ind.: Wolfram-Produktion startet - wird Sangdong zum China-Gegengewicht?', source: 'Telegram-Trader.de' },
];
const badHeadlines = headlineEvents.map(e => e.title).join('. ');
const goodSynthesis = 'Almonty has resolved legal uncertainty in Ontario while restarting its Korean tungsten operations. Other reports describe supply concerns and the start of production at Sangdong.';
const { checkSummaryQuality } = require('../lib/newsLageSummary');
test('headline concatenation and lightly edited headline lists are rejected', () => {
  assert.equal(checkSummaryQuality(badHeadlines, headlineEvents).valid, false);
  const edited = 'A tungsten price shock signals a deeper supply crisis. Almonty ends legal ambiguity in Ontario while restarting Korean tungsten output.';
  assert.equal(checkSummaryQuality(edited, headlineEvents).valid, false);
});
test('coherent synthesis and the previously verified EU output pass despite shared factual terms', () => {
  assert.equal(checkSummaryQuality(goodSynthesis, headlineEvents).valid, true);
  const events = [
    { title: 'Almonty Ships First Tungsten Concentrate From Sangdong as Rwanda Deal Widens Its Supply Base - AD HOC NEWS', source: 'AD HOC NEWS' },
    { title: 'VKA produces 69.3% tungsten concentrate at US project - Next Investors', source: 'Next Investors' },
    { title: 'Canadian Gold Mountain considers restarting tungsten mine in Brazil that operated during the Second World War - BNamericas', source: 'BNamericas' },
  ];
  const eu = 'Almonty shipped its first tungsten concentrate from Sangdong, restarting Korean output. A US project produced 69.3% tungsten concentrate. Canadian Gold Mountain plans to restart a WWII-era tungsten mine in Brazil.';
  assert.equal(checkSummaryQuality(eu, events).valid, true);
});
test('copied publisher labels and headline questions are rejected', () => {
  assert.equal(checkSummaryQuality('Almonty restarted production — AD HOC NEWS. The mine is shipping concentrate.', [{title:'Almonty restarted production — AD HOC NEWS',source:'AD HOC NEWS'}]).valid, false);
  assert.equal(checkSummaryQuality('Will Sangdong become a counterweight to China? Almonty reported its first shipment.', [{title:'Will Sangdong become a counterweight to China?'}]).valid, false);
});
test('headline output is not cached and uses the existing fallback without retries', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { NewsClassificationCache } = require('../lib/newsClassificationCache');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-quality-'));
  try {
    const cache = new NewsClassificationCache({directory,model:'local',schemaVersion:'test'});
    const input = fixture();
    input.events.china = headlineEvents.slice(0,2);
    input.managementSummary.china.topEvents = input.events.china;
    input.managementSummary.eu.status = 'empty';
    const bad = 'The Tungsten Price Shock Signals Deeper Supply Crisis. Almonty Ends Legal Ambiguity in Ontario While Restarting Korean Tungsten Output.';
    let calls = 0;
    const result = await summarizeNewsLage(input, {cache,fetch:async()=>{calls++;return {ok:true,json:async()=>({message:{content:JSON.stringify({summary:bad})}})};}});
    assert.match(result.managementSummary.china.text, /^The selected reports cover/);
    assert.equal(calls,1);
    assert.deepEqual(cache.entries,{});
    assert.equal(fs.existsSync(cache.file),false);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
test('cached headline output is revalidated against the selected titles', async () => {
  const input=fixture(); input.events.china=headlineEvents; input.managementSummary.china.topEvents=headlineEvents;input.managementSummary.eu.status='empty';
  let calls=0;
  const result=await summarizeNewsLage(input,{cache:{get:()=>({summary:'The Tungsten Price Shock Signals Deeper Supply Crisis. Almonty Ends Legal Ambiguity in Ontario While Restarting Korean Tungsten Output.'}),set(){}},fetch:async()=>{calls++;return {ok:true,json:async()=>({message:{content:JSON.stringify({summary:goodSynthesis})}})};}});
  assert.equal(calls,1);
  assert.equal(result.managementSummary.china.text,goodSynthesis);
});
