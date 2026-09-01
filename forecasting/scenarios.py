"""Historisch kalibrierte Szenario-/Stress-Test-Engine (KEINE kausale Ursache-Wirkung-Prognose).

Methodischer Hinweis (WICHTIG):
Es liegen keine gelabelten historischen News-Ereignisse vor (z.B. "am Datum X trat
Exportverknappung Y auf und der Preis änderte sich um Z%"). Deshalb kann dieses Modul
NICHT lernen oder behaupten, dass ein Ereignistyp (Exportverknappung, Nachfrageschock, ...)
kausal eine bestimmte Preisänderung bewirkt. Stattdessen wird jedes Szenario als
Stresstest umgesetzt: eine qualitative Einschätzung (Richtung, Schwere, Konfidenz,
Regionsrelevanz) wird auf ein Quantil der TATSÄCHLICH beobachteten historischen
Verteilung künftiger Preisänderungen ("forward returns") abgebildet. Ein "supplyShock"
mit hoher Schwere bedeutet damit: "eine Preisentwicklung wie sie historisch nur in den
oberen ~2,5% der beobachteten Wochenfenster vorkam" - nicht "Exportverknappungen erzeugen
+X%". Alle Zahlenwerte (Quantile, Renditen) stammen ausschließlich aus der echten
Excel-Historie bzw. der Baseline-Modellprognose (`forecasting.pipeline`), es werden keine
festen Prozentsätze pro Monat hartkodiert.

Ablauf je Szenario und Markt (China/EU getrennt, da beide ihre eigene historische
Renditeverteilung haben):
  1. `historical_forward_return_distributions()`: für h in {4, 12, 26, 52} Wochen wird aus
     der realen Wochenpreisreihe die empirische Verteilung von `price[t+h]/price[t] - 1`
     über alle historisch verfügbaren t gebildet.
  2. `effective_severity()` = severity * confidence * relevance (alle in [0, 1]).
  3. `quantile_for_direction()`: bullish -> 0.50 + 0.475*effectiveSeverity,
     bearish -> 0.50 - 0.475*effectiveSeverity (begrenzt auf [0.025, 0.975]).
  4. `quantile_target_returns()`: je Horizont h das empirische Quantil dieser Verteilung.
  5. `build_cumulative_return_path()`: glatter Wochenpfad zwischen den 4 Stützstellen
     (0, 4, 12, 26, 52 Wochen) per linearer Interpolation im LOG-Renditeraum (mathematisch
     konsistent mit Zinseszins/Compounding, vermeidet Knicke in einfachen Prozentrenditen).
  6. `apply_scenario_to_baseline()`: der interpolierte Wochenpfad wird MULTIPLIKATIV auf die
     bestehende Baseline-Wochenprognose (`forecasting.pipeline.build_baseline_forecast`)
     angewendet - die Baseline-Prognose selbst wird dadurch nicht verändert/ersetzt.

Dieses Modul ist eigenständig lauffähig (`python -m forecasting.scenarios` bzw.
`python forecasting/scenarios.py --json`) und liefert eine Liste von Szenario-Dicts im
bestehenden Frontend-Format (id/name/shortName/sentiment/summary/china[12]/eu[12]/
expectedChange12m), ergänzt um `kind="stress_test"` und `metadata` (method/severity/
confidence/quantile je Markt) zur Transparenz über die verwendete Methodik.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

from forecasting.backtest import MARKET_COLUMNS
from forecasting.load_data import load_weekly_market_data
from forecasting.pipeline import FORECAST_MONTHS, build_baseline_forecast, _prepare_market_series

logger = logging.getLogger(__name__)

# Stützstellen-Horizonte in Wochen, für die historische Forward-Returns berechnet werden.
HORIZONS_WEEKS: tuple[int, ...] = (4, 12, 26, 52)

# Begrenzung der aus Schwere/Konfidenz/Relevanz abgeleiteten Quantile auf ca. 2,5%..97,5%
# (effectiveSeverity in [0,1] * 0.475 => Quantil-Offset max. +-0.475 um den Median 0.50).
QUANTILE_SPAN = 0.475

# ---- Szenario-Vorlagen ------------------------------------------------------
# Enthalten AUSSCHLIESSLICH qualitative Annahmen (Richtung, Schwere, Konfidenz,
# Regionsrelevanz) - KEINE hartkodierten Prozent-pro-Monat-Regeln. Die tatsächlichen
# Zahlenwerte entstehen erst durch Abbildung auf die reale historische Renditeverteilung.
SCENARIO_TEMPLATES: list[dict] = [
    {
        "id": "supplyShock",
        "name": "Angebotsverknappung China (Exportkontrollen / Minenschließungen)",
        "shortName": "Angebotsschock",
        "color": "#d1495b",
        "sentiment": "bullish",
        "summary": (
            "Verschärfte chinesische Exportlizenzpflichten, Förderkürzungen und Lagerhaltung "
            "außerhalb Chinas verknappen das Weltmarktangebot spürbar. EU-Aufschlag weitet sich "
            "zusätzlich aus. Stresstest: Preisentwicklung wie in historisch stark angebotsgetriebenen "
            "Perioden, nicht als kausale Ursache-Wirkung-Aussage zu verstehen."
        ),
        "direction": "bullish",
        "severity": 0.75,
        "confidence": 0.75,
        "chinaRelevance": 1.0,
        "euRelevance": 0.9,
    },
    {
        "id": "demandSlowdown",
        "name": "Globale Nachfrageabschwächung",
        "shortName": "Nachfrage schwach",
        "color": "#2a9d8f",
        "sentiment": "bearish",
        "summary": (
            "Schwache Industriekonjunktur (PMI-Daten), steigende Recyclingquoten und Lagerabbau bei "
            "Verarbeitern dämpfen die Nachfrage in beiden Regionen. Stresstest anhand historisch "
            "schwacher Preisphasen, keine kausale Prognose."
        ),
        "direction": "bearish",
        "severity": 0.5,
        "confidence": 0.7,
        "chinaRelevance": 0.8,
        "euRelevance": 0.6,
    },
    {
        "id": "demandSurge",
        "name": "Grüne-Tech- & Rüstungsnachfrage steigt",
        "shortName": "Tech/Rüstung",
        "color": "#e08e2f",
        "sentiment": "bullish",
        "summary": (
            "Höhere Rüstungsausgaben, Halbleiter- und Energiewende-Investitionen erhöhen den Bedarf "
            "an verschleißfesten Hartmetallwerkzeugen. Stresstest anhand historisch nachfragegetriebener "
            "Aufwärtsphasen, keine kausale Prognose."
        ),
        "direction": "bullish",
        "severity": 0.45,
        "confidence": 0.65,
        "chinaRelevance": 0.7,
        "euRelevance": 0.8,
    },
    {
        "id": "euRegulation",
        "name": "EU-Regulatorik (Critical Raw Materials Act, Vorratspflicht, Zölle)",
        "shortName": "EU-Regulatorik",
        "color": "#7b52ab",
        "sentiment": "bullish-eu",
        "summary": (
            "Einstufung als kritischer Rohstoff, Vorratshaltungspflichten und mögliche Zölle auf "
            "chinesische Importe erhöhen gezielt die Kosten für europäische Abnehmer, während China "
            "kaum betroffen ist. Stresstest, keine kausale Prognose."
        ),
        "direction": "bullish",
        "severity": 0.6,
        "confidence": 0.7,
        "chinaRelevance": 0.15,
        "euRelevance": 0.95,
    },
    {
        "id": "extremeExportStop",
        "name": "Extremszenario: vollständiger chinesischer Exportstopp",
        "shortName": "Extrem: Exportstopp",
        "color": "#8b0000",
        "sentiment": "bullish",
        "summary": (
            "Extremannahme eines nahezu vollständigen Erliegens chinesischer Wolfram-Exporte. "
            "Stresstest am oberen Rand (~97,5%-Quantil) der historisch beobachteten "
            "Preisänderungen, keine kausale Prognose und kein garantiertes Eintreten."
        ),
        "direction": "bullish",
        "severity": 0.97,
        "confidence": 0.85,
        "chinaRelevance": 1.0,
        "euRelevance": 1.0,
    },
    {
        "id": "extremeDemandCollapse",
        "name": "Extremszenario: globaler Nachfrageeinbruch",
        "shortName": "Extrem: Nachfrageeinbruch",
        "color": "#0b3d91",
        "sentiment": "bearish",
        "summary": (
            "Extremannahme eines schweren globalen Konjunktureinbruchs mit stark rückläufiger "
            "Industrienachfrage. Stresstest am unteren Rand (~2,5%-Quantil) der historisch "
            "beobachteten Preisänderungen, keine kausale Prognose und kein garantiertes Eintreten."
        ),
        "direction": "bearish",
        "severity": 0.97,
        "confidence": 0.8,
        "chinaRelevance": 0.9,
        "euRelevance": 0.9,
    },
]


def clamp01(value: float) -> float:
    return float(min(1.0, max(0.0, value)))


def clamp_signed(value: float) -> float:
    return float(min(1.0, max(-1.0, value)))


def effective_severity(severity: float, confidence: float, relevance: float) -> float:
    """effectiveSeverity = severity * confidence * relevance, alle Faktoren in [0, 1]."""
    return clamp01(severity) * clamp01(confidence) * clamp01(relevance)


def quantile_for_direction(direction: str, eff_severity: float) -> float:
    """Bildet Richtung + effectiveSeverity auf ein Quantil der Forward-Return-Verteilung ab.

    bullish -> 0.50 + 0.475*effectiveSeverity, bearish -> 0.50 - 0.475*effectiveSeverity,
    neutral -> 0.50 (Median, keine Verschiebung). Auf [0.025, 0.975] begrenzt.
    """
    if direction == "bullish":
        q = 0.50 + QUANTILE_SPAN * eff_severity
    elif direction == "bearish":
        q = 0.50 - QUANTILE_SPAN * eff_severity
    else:
        q = 0.50
    return float(min(0.975, max(0.025, q)))


def historical_forward_returns(prices: np.ndarray, horizon_weeks: int) -> np.ndarray:
    """forward_return_h = price[t+h]/price[t] - 1 für alle t, an denen beide Werte real vorliegen."""
    if len(prices) <= horizon_weeks:
        return np.array([], dtype=float)
    return prices[horizon_weeks:] / prices[:-horizon_weeks] - 1.0


def historical_forward_return_distributions(prices: pd.Series) -> dict[int, np.ndarray]:
    """Liefert je Horizont (4/12/26/52 Wochen) die empirische Verteilung realer Forward-Returns."""
    values = prices.to_numpy(dtype=float)
    return {h: historical_forward_returns(values, h) for h in HORIZONS_WEEKS}


def quantile_target_returns(distributions: dict[int, np.ndarray], quantile: float) -> dict[int, float]:
    """Empirisches Quantil der historischen Forward-Return-Verteilung je Horizont."""
    targets: dict[int, float] = {}
    for h, dist in distributions.items():
        targets[h] = float(np.quantile(dist, quantile)) if dist.size else 0.0
    return targets


def build_cumulative_return_path(target_returns: dict[int, float], total_weeks: int) -> np.ndarray:
    """Glatter Wochenpfad kumulativer Renditen zwischen den Stützstellen (0,4,12,26,52 Wochen).

    Interpolation im Log-Renditeraum (log1p) ist mathematisch konsistent mit Compounding
    (kumulative Log-Renditen addieren sich linear über die Zeit) und vermeidet Knicke, die
    eine lineare Interpolation einfacher Prozentrenditen erzeugen würde.
    """
    anchor_weeks = np.array([0, *HORIZONS_WEEKS], dtype=float)
    anchor_log_returns = np.array([0.0] + [np.log1p(target_returns[h]) for h in HORIZONS_WEEKS])
    query_weeks = np.arange(1, total_weeks + 1, dtype=float)
    interpolated_log_returns = np.interp(query_weeks, anchor_weeks, anchor_log_returns)
    return np.expm1(interpolated_log_returns)


def apply_scenario_to_baseline(baseline_weekly_p50: list[float], cumulative_returns: np.ndarray) -> list[float]:
    """Wendet den Szenario-Renditepfad MULTIPLIKATIV auf die Baseline-Wochenprognose an."""
    return [round(float(p * (1.0 + r)), 2) for p, r in zip(baseline_weekly_p50, cumulative_returns)]


def _monthly_last_value(weekly_df: pd.DataFrame, reference_month: pd.Period, max_months: int) -> pd.DataFrame:
    """Aggregiert eine {week, price}-Wochenreihe auf Monate NACH `reference_month` (letzter Wert je Monat).

    Identische Regel wie `forecasting.pipeline._monthly_forecast_frame`, damit Szenario- und
    Baseline-Monatsachse exakt übereinstimmen.
    """
    df = weekly_df.copy()
    df["month"] = df["week"].dt.to_period("M")
    df = df[df["month"] > reference_month]
    return df.groupby("month", as_index=False).last().sort_values("month").head(max_months).reset_index(drop=True)


def _build_single_scenario(
    template: dict,
    baseline: dict,
    distributions_by_market: dict[str, dict[int, np.ndarray]],
    reference_month: pd.Period,
) -> dict:
    direction = template["direction"]
    severity = template["severity"]
    confidence = template["confidence"]

    monthly_series: dict[str, list[float]] = {}
    expected_change: dict[str, float] = {}
    metadata_by_market: dict[str, dict] = {}

    for market, relevance_key in (("china", "chinaRelevance"), ("eu", "euRelevance")):
        relevance = template[relevance_key]
        eff_severity = effective_severity(severity, confidence, relevance)
        quantile = quantile_for_direction(direction, eff_severity)

        target_returns = quantile_target_returns(distributions_by_market[market], quantile)

        weekly_forecast = baseline[market]["weekly_forecast"]
        baseline_p50 = [row["p50"] for row in weekly_forecast]
        cumulative_returns = build_cumulative_return_path(target_returns, len(baseline_p50))
        scenario_weekly_prices = apply_scenario_to_baseline(baseline_p50, cumulative_returns)

        weekly_df = pd.DataFrame({
            "week": [pd.Timestamp(row["week"]) for row in weekly_forecast],
            "price": scenario_weekly_prices,
        })
        monthly_frame = _monthly_last_value(weekly_df, reference_month, FORECAST_MONTHS)
        series = [round(float(v), 2) for v in monthly_frame["price"]]
        monthly_series[market] = series

        last_observed_price = baseline[market]["last_observed"]["price"]
        expected_change[market] = round(((series[-1] / last_observed_price) - 1.0) * 100.0, 1) if series else 0.0

        metadata_by_market[market] = {
            "severity": severity,
            "confidence": confidence,
            "relevance": relevance,
            "effectiveSeverity": round(eff_severity, 4),
            "quantile": round(quantile, 4),
            "targetReturnsByHorizonWeeks": {str(h): round(r, 4) for h, r in target_returns.items()},
        }

    return {
        "id": template["id"],
        "name": template["name"],
        "shortName": template["shortName"],
        "color": template["color"],
        "sentiment": template["sentiment"],
        "summary": template["summary"],
        "china": monthly_series["china"],
        "eu": monthly_series["eu"],
        "expectedChange12m": expected_change,
        "kind": "stress_test",
        "metadata": {
            "method": "historical_quantile",
            "direction": direction,
            "byMarket": metadata_by_market,
        },
    }


def build_scenarios(weekly_df: pd.DataFrame | None = None, baseline: dict | None = None) -> list[dict]:
    """Baut alle Szenario-Vorlagen (`SCENARIO_TEMPLATES`) zu vollständigen, frontend-kompatiblen Dicts aus.

    Args:
        weekly_df: Optional bereits geladene `load_weekly_market_data()`-Ausgabe.
        baseline: Optional bereits berechnete `build_baseline_forecast()`-Ausgabe (52-Wochen-p50
            je Markt), um doppelte Backtests/Fits zu vermeiden, wenn dies bereits andernorts
            (z.B. `forecasting.pipeline.build_frontend_payload`) berechnet wurde.

    Returns:
        Liste von Szenario-Dicts im bestehenden Frontend-Format (id/name/shortName/sentiment/
        summary/china[12]/eu[12]/expectedChange12m), ergänzt um kind="stress_test" und
        metadata (method="historical_quantile", je Markt severity/confidence/relevance/quantile).
    """
    weekly_df = load_weekly_market_data() if weekly_df is None else weekly_df
    baseline = build_baseline_forecast(weekly_df=weekly_df) if baseline is None else baseline

    series_by_market = {m: _prepare_market_series(weekly_df, col) for m, col in MARKET_COLUMNS.items()}
    reference_month = max(s["week"].iloc[-1].to_period("M") for s in series_by_market.values())
    distributions_by_market = {
        m: historical_forward_return_distributions(series_by_market[m]["price"]) for m in MARKET_COLUMNS
    }

    return [
        _build_single_scenario(template, baseline, distributions_by_market, reference_month)
        for template in SCENARIO_TEMPLATES
    ]


def build_news_adjusted_scenario(
    china_score: float,
    eu_score: float,
    available: bool = True,
    weekly_df: pd.DataFrame | None = None,
    baseline: dict | None = None,
) -> dict:
    """Baut das dynamische, newsgesteuerte "currentMarket"-Szenario ("Aktuelle Marktlage").

    Kombiniert die reale historische Forward-Return-Verteilung mit der deterministischen
    News-Signal-Aggregation aus lib/newsSignals.js (`marketState.china.overall` /
    `marketState.eu.overall`, je in [-1, 1]). Die KI liefert an KEINER Stelle einen Preiswert:
    sie klassifiziert nur einzelne News (Richtung/Schwere/Konfidenz/Regionsrelevanz),
    lib/newsSignals.js aggregiert das deterministisch zu `china_score`/`eu_score`, und dieses
    Modul bildet ausschließlich das VORZEICHEN (Richtung) und den BETRAG (Marktdruck) dieser
    beiden Scores auf ein Quantil der echten historischen Renditeverteilung ab - exakt dieselbe
    Methodik wie bei den festen Stresstest-Vorlagen (`quantile_for_direction`,
    `build_cumulative_return_path`).

    Konvergenz zur Baseline (Decay): Es wird die ABWEICHUNG vom 50%-Quantil (Median der
    historischen Verteilung) verwendet statt des absoluten Quantil-Zielwerts. Dadurch gilt exakt:
    score == 0 => quantile == 0.50 => Abweichung == 0 => Szenario == Baseline. Da `china_score`/
    `eu_score` bereits einen exponentiellen Freshness-Decay (Halbwertszeit) aus
    lib/newsSignals.js enthalten, konvergiert "Aktuelle Marktlage" bei jedem /api/refresh-Aufruf
    automatisch zurück zur Baseline, sobald relevante News fehlen oder veralten - ohne einen
    zusätzlichen Decay-Mechanismus in diesem Modul.

    Args:
        china_score: `marketState.china.overall` (Vorzeichen=Richtung, Betrag=Marktdruck).
        eu_score: `marketState.eu.overall`.
        available: False, wenn aktuell keine live abgerufenen bzw. KI-klassifizierten News
            vorliegen. Numerisch entspricht das Szenario dann bereits der Baseline (score sollte
            in diesem Fall 0.0 übergeben werden); dieses Flag macht das zusätzlich in
            `metadata.available` EXPLIZIT sichtbar, statt nur implizit auf Nullwerte zu vertrauen.
        weekly_df: Optional bereits geladene `load_weekly_market_data()`-Ausgabe.
        baseline: Optional bereits berechnete `build_baseline_forecast()`-Ausgabe.

    Returns:
        Szenario-Dict im bestehenden Frontend-Format, ergänzt um kind="news_adjusted" und
        metadata (method="historical_quantile", source="news_marketState", available, je Markt
        score/direction/pressure/quantile/deviationReturnsByHorizonWeeks).
    """
    weekly_df = load_weekly_market_data() if weekly_df is None else weekly_df
    baseline = build_baseline_forecast(weekly_df=weekly_df) if baseline is None else baseline

    series_by_market = {m: _prepare_market_series(weekly_df, col) for m, col in MARKET_COLUMNS.items()}
    reference_month = max(s["week"].iloc[-1].to_period("M") for s in series_by_market.values())
    distributions_by_market = {
        m: historical_forward_return_distributions(series_by_market[m]["price"]) for m in MARKET_COLUMNS
    }

    scores = {"china": clamp_signed(china_score), "eu": clamp_signed(eu_score)}
    monthly_series: dict[str, list[float]] = {}
    expected_change: dict[str, float] = {}
    metadata_by_market: dict[str, dict] = {}

    for market in MARKET_COLUMNS:
        score = scores[market]
        direction = "bullish" if score > 1e-9 else "bearish" if score < -1e-9 else "neutral"
        pressure = abs(score)
        quantile = quantile_for_direction(direction, pressure)

        dist = distributions_by_market[market]
        target_returns = quantile_target_returns(dist, quantile)
        median_returns = quantile_target_returns(dist, 0.5)
        # Abweichung vom Median statt absolutem Quantil-Zielwert => score=0 garantiert Szenario==Baseline.
        deviation_returns = {h: target_returns[h] - median_returns[h] for h in target_returns}

        weekly_forecast = baseline[market]["weekly_forecast"]
        baseline_p50 = [row["p50"] for row in weekly_forecast]
        cumulative_returns = build_cumulative_return_path(deviation_returns, len(baseline_p50))
        scenario_weekly_prices = apply_scenario_to_baseline(baseline_p50, cumulative_returns)

        weekly_price_df = pd.DataFrame({
            "week": [pd.Timestamp(row["week"]) for row in weekly_forecast],
            "price": scenario_weekly_prices,
        })
        monthly_frame = _monthly_last_value(weekly_price_df, reference_month, FORECAST_MONTHS)
        series = [round(float(v), 2) for v in monthly_frame["price"]]
        monthly_series[market] = series

        last_observed_price = baseline[market]["last_observed"]["price"]
        expected_change[market] = round(((series[-1] / last_observed_price) - 1.0) * 100.0, 1) if series else 0.0

        metadata_by_market[market] = {
            "score": round(score, 4),
            "direction": direction,
            "pressure": round(pressure, 4),
            "quantile": round(quantile, 4),
            "deviationReturnsByHorizonWeeks": {str(h): round(v, 4) for h, v in deviation_returns.items()},
        }

    dominant_market = "china" if abs(scores["china"]) >= abs(scores["eu"]) else "eu"
    dominant_score = scores[dominant_market]
    if not available or abs(dominant_score) < 1e-9:
        overall_direction = "neutral"
    elif dominant_score > 0:
        overall_direction = "bullish"
    else:
        overall_direction = "bearish"
    color = {"bullish": "#2a9d8f", "bearish": "#d1495b", "neutral": "#6b7789"}[overall_direction]

    return {
        "id": "currentMarket",
        "name": "Aktuelle Marktlage",
        "shortName": "Aktuelle Marktlage",
        "color": color,
        "sentiment": overall_direction,
        "china": monthly_series["china"],
        "eu": monthly_series["eu"],
        "expectedChange12m": expected_change,
        "kind": "news_adjusted",
        "metadata": {
            "method": "historical_quantile",
            "source": "news_marketState",
            "available": bool(available),
            "byMarket": metadata_by_market,
        },
    }


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Historisch kalibrierte Szenario-/Stress-Test-Engine.")
    parser.add_argument(
        "--json", action="store_true",
        help="Nur das JSON-Ergebnis auf stdout ausgeben, Logging geht an stderr.",
    )
    parser.add_argument(
        "--current-market", action="store_true",
        help="Statt der festen Vorlagen NUR das dynamische, newsgesteuerte 'currentMarket'-"
             "Szenario bauen (siehe --china-score/--eu-score/--unavailable).",
    )
    parser.add_argument("--china-score", type=float, default=0.0, help="marketState.china.overall in [-1,1].")
    parser.add_argument("--eu-score", type=float, default=0.0, help="marketState.eu.overall in [-1,1].")
    parser.add_argument(
        "--unavailable", action="store_true",
        help="Markiert 'currentMarket' explizit als nicht verfügbar (keine live/klassifizierten News).",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s", stream=sys.stderr)

    if args.current_market:
        sc = build_news_adjusted_scenario(args.china_score, args.eu_score, available=not args.unavailable)
        if args.json:
            print(json.dumps(sc, ensure_ascii=False))
        else:
            print(f"\n=== {sc['id']} ({sc['name']}) ===")
            print(f"Verfügbar: {sc['metadata']['available']}, Methode: {sc['metadata']['method']}, Sentiment: {sc['sentiment']}")
            for market in ("china", "eu"):
                meta = sc["metadata"]["byMarket"][market]
                print(
                    f"  {market}: score={meta['score']} -> Richtung={meta['direction']}, "
                    f"Marktdruck={meta['pressure']} -> Quantil={meta['quantile']}"
                )
                print(f"    Abweichung vom Median je Horizont: {meta['deviationReturnsByHorizonWeeks']}")
            print(f"  expectedChange12m: {sc['expectedChange12m']}")
            print(f"  china[12]: {sc['china']}")
            print(f"  eu[12]:    {sc['eu']}")
    else:
        scenarios = build_scenarios()

        if args.json:
            print(json.dumps(scenarios, ensure_ascii=False))
        else:
            for sc in scenarios:
                print(f"\n=== {sc['id']} ({sc['name']}) ===")
                print(f"Richtung: {sc['metadata']['direction']}, Methode: {sc['metadata']['method']}")
                for market in ("china", "eu"):
                    meta = sc["metadata"]["byMarket"][market]
                    print(
                        f"  {market}: severity={meta['severity']}, confidence={meta['confidence']}, "
                        f"relevance={meta['relevance']} -> effectiveSeverity={meta['effectiveSeverity']} "
                        f"-> Quantil={meta['quantile']}"
                    )
                    print(f"    Ziel-Forward-Returns je Horizont: {meta['targetReturnsByHorizonWeeks']}")
                print(f"  expectedChange12m: {sc['expectedChange12m']}")
                print(f"  china[12]: {sc['china']}")
                print(f"  eu[12]:    {sc['eu']}")
