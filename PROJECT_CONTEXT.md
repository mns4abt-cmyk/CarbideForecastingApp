# Wolfram-Carbide Marktradar — Project Context

## Stable domain rules
- EU price unit: **USD/mtu WO3**. China price unit: **CNY/kg APT**.
- Do not compare raw EU and China prices on one axis. In `both` mode the UI normalizes each series to an index with the final historical value = 100.
- Numerical baseline forecasts must come from statistical/time-series models selected by walk-forward backtesting; an LLM must never generate prices, price targets, percentage changes, or forecast paths.
- LLM output is limited to structured news classification: category, direction, severity, confidence, China/EU relevance, horizon, summary, and qualitative impact explanation.
- In LLM classifications, `direction` means tungsten/APT **price** pressure only: bullish = upward, bearish = downward, neutral = no clear price pressure; it never means favourable/unfavourable industry sentiment.
- News is evidence/signalling only. It must not directly set a price movement; statistical evidence has priority.

## Runtime architecture
- `server.js` is the Express server, serves `public/`, loads `.env`, and exposes `GET /api/status` and `POST /api/refresh`.
- `public/js/app.js` loads `/api/status` on startup and calls `/api/refresh`; its response replaces the browser bootstrap data.
- `public/js/chart.js` renders the dependency-free SVG chart; `public/js/data.js` is a UMD data/scenario helper shared by browser and Node.

## Real market data and baseline
- Source workbooks are `data/APT_Tungsten_EU.xlsx` and `data/APT_Tungsten_China.xlsx`.
- `forecasting/load_data.py` reads EU `data_table` (`PriceDate`, `Price`, expected `USD/mtu WO3`) and China `Sheet1` (`日期` + `MID`, CNY/kg APT), cleans them, and resamples each to Friday-ending weeks using only each week's final actual observation (no filling).
- `forecasting/backtest.py` uses rolling/expanding walk-forward validation at 4, 12, and 26 weeks. It compares Naive, AutoARIMA, AutoETS, and AutoTheta; a complex model must beat Naive at a majority of horizons.
- `forecasting/pipeline.py` fits the selected model on real history, forecasts 52 weeks with an 80% interval (P10/P50/P90), and emits 24 monthly historical points plus up to 12 monthly forecast points for the frontend.
- `server.js` executes `forecasting/pipeline.py --json` for each refresh. Python is resolved cross-platform: `FORECAST_PYTHON` is the explicit override, then project-local `.venv`/`venv`, then platform commands. No machine-specific path is committed.

## Scenarios
- `forecasting/scenarios.py` contains the intended historically calibrated stress-test engine: qualitative assumptions map to quantiles of empirical 4/12/26/52-week forward-return distributions and are applied multiplicatively to the statistical baseline.
- Its `currentMarket` path converts deterministic aggregated news pressure to a historical-return quantile deviation; score zero equals the baseline.
- `forecasting/pipeline.py` emits the frontend scenario list: an unchanged P50 baseline plus fixed stress tests from `forecasting.scenarios.build_scenarios()` using the same loaded history and fitted baseline. `server.js` forwards this list on successful refresh and does not use `CarbideData.computeScenarioSeries()`.

## News and BMF
- News retrieval uses a configurable multi-source registry (`config/news-sources.json`, `lib/newsSources.js`). Google News is optional; direct RSS/Atom sources are supported and normalize before future relevance filtering. The local-first target retains a local default LLM.
- On Windows corporate networks where `HTTP_PROXY`/`HTTPS_PROXY` requires integrated authentication, public news retrieval uses a Windows-only `curl.exe` transport with proxy Negotiate authentication; other platforms retain the Node/Undici transport. `localhost`, `127.0.0.1`, and Ollama remain proxy-bypassed. No proxy credentials or authorization tokens are stored in source code or `.env`.
- After source normalization and cross-source deduplication, `lib/newsRelevance.js` applies a deterministic tungsten-market relevance filter before any LLM classification. Rejected articles do not enter LLM classification, market-signal aggregation, or the frontend news list.
- `lib/newsClassifierProviders.js` provides the semantic-only LLM layer. Default `LLM_PROVIDER=ollama` uses local Ollama at `http://127.0.0.1:11434` with `qwen3:4b`, requiring no API key. BMF remains optional through `LLM_PROVIDER=bmf` and its server-side `.env` settings.
- Deterministic relevance filtering occurs before LLM selection. At most `MAX_LLM_ARTICLES` (default 12), ranked by relevance then recency, are classified from title/snippet/publisher/date only; Ollama processes them sequentially in `OLLAMA_BATCH_SIZE` batches (default 3), preserving successful batches if another fails. No price, baseline, scenario, or forecast data enters the LLM.
- The LLM extracts `supplyEffect`, `demandEffect`, and `eventStage`; `lib/newsCausality.js` deterministically derives production direction and records LLM disagreements. Study/exploration/speculative supply is not current supply. `lib/newsEventDedup.js` conservatively deduplicates syndicated events before signal aggregation, while response provenance remains visible. `lib/newsClassificationCache.js` caches validated classifications under `.cache/`, keyed by article content, model, and schema version.
- Classifications also contain `globalRelevance` (materiality to the international tungsten/APT supply-demand balance, not popularity), distinct from direct China/EU relevance. `eventStage` deterministically maps to evidence maturity (`realized`, `prospective`, `speculative`, `unclear`) and conservatively caps prospective/speculative severity. `lib/newsEventEvidence.js` emits provider-neutral event evidence with provenance; it is not Evidence Fusion and has no numerical forecast impact.
- `lib/evidenceFusion.js` produces read-only, horizon-specific baseline/news corroboration diagnostics. `/api/refresh` exposes it as `evidenceFusion`; it must never influence the baseline, scenarios, `currentMarket`, model selection, reliability, or chart values.
- Forecasting remains independent from news/LLM. `lib/newsSignals.js` aggregates only successfully validated classifications with a 14-day freshness half-life; unavailable/malformed LLM output creates no market signal and leaves `currentMarket` baseline-equivalent.

## Historical event-price association
- Validated, event-deduplicated news evidence and its separate `news_event_price_outcomes` rows are retained in local SQLite (`data/news-events.db`). The outcome key is `(eventId, market, horizonWeeks)`, so reruns upsert rather than duplicate records; no event or outcome retention deletion is applied.
- `lib/eventPriceAssociation.js` reuses the normalized weekly price series. `priceAtEvent` is the latest valid observation on or before the event date. For 1/4/12/26-week outcomes, the first valid observation on or after the target date is accepted only within the documented seven-day tolerance and never after the explicit as-of/reference date. A future target stays `pending`; an elapsed target without a valid observation is explicitly `unavailable` rather than fabricated.
- `lib/eventOutcomePendingRefresh.js` runs after durable event persistence during `/api/refresh`, checks only pending rows, and skips price-series loading if there are none. It updates only those pending horizons and logs pending checked, newly completed, and still pending; failures are isolated from refresh.
- Historical association, subsequent-movement aggregation, direction validation, diagnostics, and the secondary UI are read-only event-study layers. They never modify P50, model selection, reliability, Evidence Fusion, News-Lage sentiment, `currentMarket`, or stress scenarios. UI and diagnostics describe association/subsequent movement only and make no causal claim.

## Bootstrap/legacy caveat
- Before a successful backend refresh, `public/js/data.js` displays illustrative offline/bootstrap data. A successful refresh replaces it with pipeline history, baseline, and Python-generated fixed stress scenarios.
