const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const panel = require('../public/js/newsLageManagementPanel');

function fixture() {
  const summary = (market) => ({ status: 'available', text: `${market} API summary.  Keep this exactly.`,
    qualitativeLabel: market === 'China' ? 'bearish' : 'bullish', totalEventCount: 9,
    directionalEventCount: 6, topEvents: Array.from({ length: 5 }, (_, i) => ({
      eventKey: `${market}-${i}`, date: '2026-10-01', title: `${market} event ${i + 1}`,
      source: 'Publisher', direction: 'bearish', category: 'supply', eventStage: 'actual',
      evidenceMaturity: 'realized', finalWeight: 0.12345,
    })) });
  return { available: true, china: { sentimentScore: 77.123 }, eu: { sentimentScore: -88.123 },
    managementSummary: { china: summary('China'), eu: summary('EU') }, events: { china: [], eu: [] } };
}
for (const region of ['china', 'eu', 'both']) {
  test(`${region} renders separate API summaries and labels without score-derived direction`, () => {
    const input = fixture();
    const before = structuredClone(input);
    const html = panel.render({ newsLage: input, region });
    for (const [key, name] of [['china', 'China'], ['eu', 'EU']]) {
      assert.equal(html.includes(`${name} API summary.  Keep this exactly.`), region === key || region === 'both');
    }
    if (region !== 'eu') assert.match(html, /Aktuelle Einordnung[\s\S]*?bearish/);
    if (region !== 'china') assert.match(html, /Aktuelle Einordnung[\s\S]*?bullish/);
    assert.deepEqual(input, before);
  });
}
test('three-event preview, all five in closed details, technical values only in details', () => {
  const html = panel.render({ newsLage: fixture(), region: 'china' });
  const [primary, details] = html.split('<details');
  assert.equal((primary.match(/China event /g) || []).length, 3);
  assert.equal((details.match(/China event /g) || []).length, 5);
  assert.doesNotMatch(primary, /77\.123|0\.12345|Sentiment Score/);
  assert.match(details, /77\.123/);
  assert.match(details, /0\.12345/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(details, /Die News-Lage basiert auf validierten Nachrichtenereignissen der letzten 30 Tage\. Neuere und materiellere Ereignisse erhalten ein höheres Gewicht\. Der statistische Preisforecast wird dadurch nicht verändert\./);
});
test('both mode preserves independent counts and isolates an unavailable market', () => {
  const data = fixture();
  data.managementSummary.eu.totalEventCount = 17;
  data.managementSummary.eu.directionalEventCount = 11;
  let html = panel.render({ newsLage: data });
  const [china, eu] = html.split('data-market="eu"');
  assert.match(china, /<dd>9<\/dd>/);
  assert.match(china, /<dd>6<\/dd>/);
  assert.doesNotMatch(china, /<dd>17<\/dd>/);
  assert.match(eu, /<dd>17<\/dd>/);
  assert.match(eu, /<dd>11<\/dd>/);
  data.managementSummary.china.status = 'unavailable';
  html = panel.render({ newsLage: data });
  assert.match(html, /nicht verfügbar/);
  assert.match(html, /EU API summary/);
  assert.match(html, /EU event 1/);
});
test('sparse, empty, unavailable and missing summaries remain distinct', () => {
  const data = fixture();
  data.managementSummary.china.directionalEventCount = 2;
  assert.match(panel.render({ newsLage: data, region: 'china' }), /Kleine Datenbasis/);
  data.managementSummary.china = { status: 'empty', text: 'No events.', totalEventCount: 0, directionalEventCount: 0, topEvents: [] };
  assert.match(panel.render({ newsLage: data, region: 'china' }), /Keine validierten Ereignisse/);
  data.managementSummary.china = { status: 'unavailable', text: 'Insufficient information.', totalEventCount: null, directionalEventCount: null };
  const unavailable = panel.render({ newsLage: data, region: 'china' });
  assert.match(unavailable, /nicht verfügbar/);
  assert.doesNotMatch(unavailable, />0</);
  delete data.managementSummary;
  const missing = panel.render({ newsLage: data, region: 'china' });
  assert.match(missing, /nicht verfügbar/);
  assert.doesNotMatch(missing, /77\.123|bearish|bullish/);
});
test('escapes API summary and all event metadata without translating or interpreting titles', () => {
  const data = fixture();
  const malicious = '<img src=x onerror="alert(1)"> & \'text\'';
  data.managementSummary.china.text = malicious;
  data.managementSummary.china.qualitativeLabel = malicious;
  for (const field of ['title', 'source', 'category', 'eventStage', 'direction', 'evidenceMaturity']) data.managementSummary.china.topEvents[0][field] = malicious;
  const html = panel.render({ newsLage: data, region: 'china' });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; &#39;text&#39;/);
});
test('app retains full event access and historical association selection', () => {
  const source = fs.readFileSync(require.resolve('../public/js/app.js'), 'utf8');
  const fn = source.slice(source.indexOf('function renderNewsLageV2Card('), source.indexOf('function renderCurrentMarketCard('));
  const els = new Proxy({}, { get(target, key) { return target[key] ||= { style: {} }; } });
  let change;
  const state = { region: 'both' };
  const context = { els, state, window: { NewsLageManagementPanel: panel },
    document: { getElementById: () => ({ addEventListener: (_, callback) => { change = callback; } }) } };
  vm.createContext(context);
  vm.runInContext(fn, context);
  const data = fixture();
  data.events.china = [{ eventId: 'a', title: 'Full China event', finalWeight: 1, sources: ['Publisher'], priceOutcomes: [{ horizonWeeks: 4, status: 'available', priceAtEvent: 100, futurePrice: 110, returnPct: 10 }] }];
  data.events.eu = [{ eventId: 'b', title: 'Full EU event', finalWeight: 1, sources: ['Publisher'] }];
  context.renderNewsLageV2Card(data);
  assert.match(els.currentMarketChanges.innerHTML, /China API summary/);
  assert.equal(els.newsLageEvents.hidden, false);
  assert.match(els.newsLageEventsContent.innerHTML, /Full China event/);
  assert.equal(els.eventOutcomesPanel.hidden, false);
  assert.match(els.eventOutcomesContent.innerHTML, /eventOutcomeSelect/);
  assert.match(els.eventOutcomesContent.innerHTML, /110/);
  change({ target: { value: 'eu:b' } });
  assert.equal(state.selectedOutcomeEventKey, 'eu:b');
  assert.match(els.eventOutcomesContent.innerHTML, /value="eu:b" selected/);
});
