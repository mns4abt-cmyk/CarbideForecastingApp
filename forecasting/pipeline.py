"""Baseline-Prognosepipeline: Backtest-Modellauswahl -> 52-Wochen-Prognose -> Monatsanzeige.

Für EU und China wird jeweils das durch echtes Walk-Forward-Backtesting
(`forecasting.backtest`) ausgewählte Modell auf der vollständigen realen
Historie gefittet und liefert eine 52-Wochen-Prognose mit 80%-Prognose-
intervall (analytisch vom jeweiligen statsforecast-Modell selbst berechnet -
bei Naive basiert dies auf der historischen Streuung der Naive-Fehler, also
gerade NICHT auf einer willkürlichen Prozentspanne). Jeder Zahlenwert stammt
aus Modell/Historie - keine erfundenen Trends, keine künstliche Saisonalität.

Dieses Modul ist eigenständig lauffähig (`python -m forecasting.pipeline`) und
wird von server.js per `python forecasting/pipeline.py --json` aufgerufen
(siehe `build_frontend_payload()` für das dabei erzeugte JSON-Format).
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

# Erlaubt den Direktaufruf "python forecasting/pipeline.py" (z.B. aus server.js per execFile),
# ohne "python -m forecasting.pipeline": das Projekt-Wurzelverzeichnis wird dem Modulsuchpfad
# vorangestellt, BEVOR die paketinternen Importe unten aufgelöst werden.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd
import numpy as np
from statsforecast import StatsForecast

from forecasting.backtest import MARKET_COLUMNS, MAX_HORIZON, run_all_backtests, run_cross_validation
from forecasting.load_data import load_weekly_market_data
from forecasting.models import DEFAULT_SEASON_LENGTH, default_models, to_statsforecast_frame

logger = logging.getLogger(__name__)

FREQ = "W-FRI"
FORECAST_HORIZON_WEEKS = 52
INTERVAL_LEVEL = 80
HISTORY_MONTHS = 24
FORECAST_MONTHS = 12


def _prepare_market_series(weekly_df: pd.DataFrame, value_col: str) -> pd.DataFrame:
    """Lückenlose {week, price}-Reihe für einen Markt (fehlende Wochen entfernt, nicht erfunden)."""
    out = weekly_df[["week", value_col]].dropna().rename(columns={value_col: "price"})
    return out.sort_values("week").reset_index(drop=True)


def _select_model_instance(model_name: str):
    """Holt die konkrete Modellinstanz zu einem per Backtest ausgewählten Modellnamen."""
    for model in default_models(season_length=DEFAULT_SEASON_LENGTH):
        if model.alias == model_name:
            return model
    raise ValueError(f"Modell '{model_name}' ist nicht in default_models() enthalten.")


def _forecast_weekly(series: pd.DataFrame, unique_id: str, model_name: str, transformation: str) -> pd.DataFrame:
    """Punktprognose plus positive, multiplikative OOS-Fehlerintervalle."""
    transformed = series.copy()
    if transformation == "log":
        transformed["price"] = np.log(transformed["price"])
    sf_df = to_statsforecast_frame(transformed, unique_id, date_col="week", value_col="price")
    model = _select_model_instance(model_name)

    sf = StatsForecast(models=[model], freq=FREQ, n_jobs=1)
    fc_df = sf.forecast(df=sf_df, h=FORECAST_HORIZON_WEEKS)
    p50 = fc_df[model_name].to_numpy(dtype=float)
    if transformation == "log":
        p50 = np.exp(p50)

    cv = run_cross_validation(series, unique_id, models=[model], transformation=transformation)
    cv["lead"] = ((cv["ds"] - cv["cutoff"]).dt.days // 7).clip(upper=MAX_HORIZON)
    cv["error"] = np.log(cv["y"] / cv[model_name])
    fallback = cv[cv["lead"] == MAX_HORIZON]["error"].to_numpy()
    lo, hi = [], []
    for lead, point in enumerate(p50, start=1):
        errors = cv[cv["lead"] == min(lead, MAX_HORIZON)]["error"].to_numpy()
        errors = errors if errors.size else fallback
        errors = np.append(errors, 0.0)
        # Include the no-error outcome as an admissible central forecast: the
        # empirical tails may otherwise both have one sign in only six windows.
        lo_error = min(0.0, float(np.quantile(errors, .10)))
        hi_error = max(0.0, float(np.quantile(errors, .90)))
        lo.append(point * np.exp(lo_error))
        hi.append(point * np.exp(hi_error))
    result = pd.DataFrame({"week": fc_df["ds"], "p10": lo, "p50": p50, "p90": hi})
    if not ((result.p10 > 0).all() and (result.p50 > 0).all() and (result.p90 > 0).all()
            and (result.p10 <= result.p50).all() and (result.p50 <= result.p90).all()):
        raise ValueError("Ungültige Prognoseintervalle: positive und geordnete Quantile erforderlich.")
    return result


def _assess_reliability(backtest: dict, current_price: float, series: pd.DataFrame) -> dict:
    """Horizon-specific, deterministic reliability based on OOS level-scale errors.

    Labels use sMAPE, MAE/current price, Naive improvement, error dispersion and
    window count. MASE remains a model-selection diagnostic only: step-like price
    series can have an artificially small one-week naive scale.
    """
    changes = series["price"].diff().abs().dropna()
    zero_share = float((changes == 0).mean()) if len(changes) else 0.0
    median_change = float(changes.median()) if len(changes) else 0.0
    scale_note = (
        "Historical weekly-change scale is unusually small/zero-heavy; MASE is diagnostic only."
        if zero_share >= 0.25 or median_change == 0 else None
    )
    result = {}
    for horizon, selected in backtest["metrics"].items():
        naive = backtest["all_metrics"][int(horizon)][backtest["benchmark_key"]]
        mae_current_pct = selected["mae"] / current_price * 100
        improvement = (naive["mae"] - selected["mae"]) / naive["mae"] if naive["mae"] else 0.0
        dispersion = selected["mae_std"] / selected["mae"] if selected["mae"] else 0.0
        windows = selected["n_obs"]

        if selected["smape"] > 25 or mae_current_pct > 30:
            label = "VERY_LOW"
        elif (selected["smape"] <= 12.5 and mae_current_pct <= 15 and improvement >= 0
              and dispersion <= 0.75):
            # HIGH additionally requires >=8 OOS windows; current six-window setup caps at MEDIUM.
            label = "HIGH" if windows >= 8 and improvement >= 0.10 and dispersion <= 0.50 else "MEDIUM"
        else:
            label = "LOW"

        result[f"{horizon}w"] = {
            "label": label,
            "smape": round(selected["smape"], 3),
            "mae": round(selected["mae"], 3),
            "maeCurrentPricePct": round(mae_current_pct, 3),
            "maseDiagnostic": selected["mase"],
            "naiveMae": round(naive["mae"], 3),
            "maeImprovementVsNaive": round(improvement, 4),
            "errorDispersionCv": round(dispersion, 4),
            "backtestWindows": windows,
            "scaleDiagnosticNote": scale_note,
        }
    return result


def _monthly_forecast_frame(weekly_forecast: pd.DataFrame, after_month: pd.Period, max_months: int) -> pd.DataFrame:
    """Aggregiert die Wochenprognose auf Monate NACH `after_month` (letzte Wochenbeobachtung je Monat).

    `after_month` ist bewusst ein für beide Märkte GEMEINSAMER Referenzmonat (siehe
    `build_baseline_forecast`), damit EU und China exakt dieselbe Monatsachse teilen -
    Voraussetzung für eine gemeinsame Chart-Zeitachse im Frontend.
    """
    df = weekly_forecast.copy()
    df["month"] = df["week"].dt.to_period("M")
    df = df[df["month"] > after_month]
    return df.groupby("month", as_index=False).last().sort_values("month").head(max_months).reset_index(drop=True)


def _monthly_history_frame(series: pd.DataFrame, up_to_month: pd.Period, max_months: int) -> pd.DataFrame:
    """Aggregiert die reale Wochenhistorie auf Monate BIS EINSCHLIESSLICH `up_to_month`."""
    df = series.copy()
    df["month"] = df["week"].dt.to_period("M")
    df = df[df["month"] <= up_to_month]
    return df.groupby("month", as_index=False).last().sort_values("month").tail(max_months).reset_index(drop=True)


def build_frontend_scenarios(weekly_df: pd.DataFrame, baseline: dict, frontend_markets: dict) -> list[dict]:
    """Erzeugt den Frontend-Szenariovertrag aus der statistischen Baseline.

    Die P50-Baseline wird unverändert ausgegeben. Alle festen Stressszenarien
    kommen aus ``forecasting.scenarios.build_scenarios`` und verwenden dieselbe
    bereits geladene Historie sowie dieselbe bereits gefittete Baseline.
    """
    def _expected_change(values: list[float | None], last_observed: float) -> float:
        final_value = next((value for value in reversed(values) if value is not None), None)
        if final_value is None:
            return 0.0
        return round(((float(final_value) / last_observed) - 1.0) * 100.0, 1)

    baseline_scenario = {
        "id": "base",
        "name": "Basisszenario",
        "shortName": "Basis",
        "color": "#6b7789",
        "sentiment": "neutral",
        "alwaysOn": True,
        "summary": "P50 der statistischen, per Walk-Forward-Backtest ausgewählten Baseline-Prognose.",
        "china": frontend_markets["china"]["p50"],
        "eu": frontend_markets["eu"]["p50"],
        "expectedChange12m": {
            "china": _expected_change(frontend_markets["china"]["p50"], baseline["china"]["last_observed"]["price"]),
            "eu": _expected_change(frontend_markets["eu"]["p50"], baseline["eu"]["last_observed"]["price"]),
        },
        "kind": "baseline",
        "metadata": {
            "method": "walk_forward_selected_statistical_model",
            "selectedModel": {
                "china": baseline["china"]["selected_model"],
                "eu": baseline["eu"]["selected_model"],
            },
        },
    }

    # Lokaler Import verhindert einen Modulzyklus: scenarios importiert Hilfsfunktionen
    # aus diesem Modul, wird aber erst ausgeführt, nachdem die Baseline bereitsteht.
    from forecasting.scenarios import build_scenarios
    return [baseline_scenario, *build_scenarios(weekly_df=weekly_df, baseline=baseline)]


def build_baseline_forecast(weekly_df: pd.DataFrame | None = None) -> dict:
    """Baut die Baseline-Prognose (intern 52 Wochen, Anzeige ca. 12 Monate) für EU und China.

    Args:
        weekly_df: Optional bereits geladene `load_weekly_market_data()`-Ausgabe,
            um einen doppelten Excel-Read/Resample zu vermeiden (siehe `build_frontend_payload`).

    Returns:
        JSON-kompatibles Dict je Markt ("eu", "china") mit:
            "selected_model"   - per Backtest gewähltes Modell.
            "last_observed"    - letzter realer Beobachtungswert {"week", "price"}.
            "weekly_forecast"  - 52 Zeilen {"week", "p10", "p50", "p90"}.
            "monthly_forecast" - bis zu 12 Zeilen {"month", "p10", "p50", "p90"}, beginnend
                nach dem für beide Märkte gemeinsamen letzten realen Beobachtungsmonat.
    """
    weekly_df = load_weekly_market_data() if weekly_df is None else weekly_df
    backtest_results = run_all_backtests()

    series_by_market = {m: _prepare_market_series(weekly_df, col) for m, col in MARKET_COLUMNS.items()}
    # Gemeinsamer Referenzmonat (der spätere der beiden letzten realen Beobachtungsmonate),
    # damit EU und China dieselbe Monatsachse für die Anzeige-Prognose erhalten.
    reference_month = max(s["week"].iloc[-1].to_period("M") for s in series_by_market.values())

    result: dict = {}
    for market, series in series_by_market.items():
        selected_model = backtest_results[market]["selected_model"]
        transformation = backtest_results[market]["transformation"]

        logger.info(
            "Baue Baseline-Prognose für '%s' mit Modell '%s' (h=%d Wochen, Intervall=%d%%)",
            market, selected_model, FORECAST_HORIZON_WEEKS, INTERVAL_LEVEL,
        )

        weekly_forecast = _forecast_weekly(series, unique_id=market, model_name=selected_model, transformation=transformation)
        monthly_forecast = _monthly_forecast_frame(weekly_forecast, reference_month, FORECAST_MONTHS)
        last_row = series.iloc[-1]

        result[market] = {
            "selected_model": selected_model,
            "transformation": transformation,
            "reliability": _assess_reliability(backtest_results[market], float(last_row["price"]), series),
            "backtest": backtest_results[market],
            "last_observed": {
                "week": last_row["week"].strftime("%Y-%m-%d"),
                "price": round(float(last_row["price"]), 2),
            },
            "weekly_forecast": [
                {
                    "week": row["week"].strftime("%Y-%m-%d"),
                    "p10": round(float(row["p10"]), 2),
                    "p50": round(float(row["p50"]), 2),
                    "p90": round(float(row["p90"]), 2),
                }
                for _, row in weekly_forecast.iterrows()
            ],
            "monthly_forecast": [
                {
                    "month": str(row["month"]),
                    "p10": round(float(row["p10"]), 2),
                    "p50": round(float(row["p50"]), 2),
                    "p90": round(float(row["p90"]), 2),
                }
                for _, row in monthly_forecast.iterrows()
            ],
        }

    return result


def build_frontend_payload() -> dict:
    """Bringt die Baseline-Prognose in das von server.js/Frontend erwartete kompakte Format.

    Liefert eine GEMEINSAME Monatsachse für EU und China (History + Forecast getrennt),
    analog zum bisherigen data.js-Vertrag (HISTORY_LABELS/FORECAST_LABELS + China/EU-Arrays) -
    jedoch ausschließlich mit Werten aus echten Excel-Daten bzw. dem gewählten Modell.

    Returns:
        {
          "history": {"labels": ["YYYY-MM", ...], "eu": [float|None, ...], "china": [...]},
          "forecastLabels": ["YYYY-MM", ...],
          "eu":    {"selected_model": str, "last_observed": {...}, "p10": [...], "p50": [...], "p90": [...]},
          "china": {...}
        }
    """
    weekly_df = load_weekly_market_data()
    baseline = build_baseline_forecast(weekly_df=weekly_df)

    series_by_market = {m: _prepare_market_series(weekly_df, col) for m, col in MARKET_COLUMNS.items()}
    reference_month = max(s["week"].iloc[-1].to_period("M") for s in series_by_market.values())

    history_frames = {
        m: _monthly_history_frame(s, reference_month, HISTORY_MONTHS) for m, s in series_by_market.items()
    }
    history_months = sorted(set().union(*(set(f["month"]) for f in history_frames.values())))[-HISTORY_MONTHS:]
    forecast_months = sorted(set().union(*(
        {pd.Period(d["month"]) for d in baseline[m]["monthly_forecast"]} for m in MARKET_COLUMNS
    )))[:FORECAST_MONTHS]

    def _reindex(frame: pd.DataFrame, months: list[pd.Period], col: str) -> list[float | None]:
        s = frame.set_index("month")[col]
        return [None if pd.isna(s.get(m)) else round(float(s.get(m)), 2) for m in months]

    def _reindex_forecast(market: str, field: str, months: list[pd.Period]) -> list[float | None]:
        by_month = {d["month"]: d[field] for d in baseline[market]["monthly_forecast"]}
        return [by_month.get(str(m)) for m in months]

    payload: dict = {
        "history": {
            "labels": [str(m) for m in history_months],
            "eu": _reindex(history_frames["eu"], history_months, "price"),
            "china": _reindex(history_frames["china"], history_months, "price"),
        },
        "forecastLabels": [str(m) for m in forecast_months],
    }
    for market in MARKET_COLUMNS:
        payload[market] = {
            "selected_model": baseline[market]["selected_model"],
            "transformation": baseline[market]["transformation"],
            "reliability": baseline[market]["reliability"],
            "backtest": baseline[market]["backtest"],
            "last_observed": baseline[market]["last_observed"],
            "p10": _reindex_forecast(market, "p10", forecast_months),
            "p50": _reindex_forecast(market, "p50", forecast_months),
            "p90": _reindex_forecast(market, "p90", forecast_months),
        }

    payload["scenarios"] = build_frontend_scenarios(weekly_df, baseline, payload)
    return payload


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Baseline-Forecasting-Pipeline (EU/China, echte Excel-Daten).")
    parser.add_argument(
        "--json", action="store_true",
        help="Nur das kompakte JSON-Ergebnis (build_frontend_payload) auf stdout ausgeben, "
             "z.B. für den Aufruf aus server.js. Logging geht dabei ausschließlich an stderr.",
    )
    args = parser.parse_args()

    # logging.basicConfig() schreibt standardmäßig nach stderr - stdout bleibt bei --json
    # damit ausschließlich für die JSON-Nutzlast reserviert (keine Log-Zeilen vermischt sich hinein).
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s", stream=sys.stderr)

    if args.json:
        print(json.dumps(build_frontend_payload(), ensure_ascii=False))
    else:
        baseline = build_baseline_forecast()

        for market in ("eu", "china"):
            data = baseline[market]
            print(f"\n=== {market.upper()} ===")
            print(f"Ausgewähltes Modell (aus Backtest): {data['selected_model']}")
            print(f"Letzter realer Beobachtungswert: {data['last_observed']['week']} = {data['last_observed']['price']}")
            print(f"Monatliche Anzeigewerte ({len(data['monthly_forecast'])}), p10/p50/p90:")
            print(pd.DataFrame(data["monthly_forecast"]).to_string(index=False))

        print("\n=== JSON-kompaktes Ergebnis (selected_model + monthly_forecast) ===")
        compact = {
            market: {
                "selected_model": baseline[market]["selected_model"],
                "last_observed": baseline[market]["last_observed"],
                "monthly_forecast": baseline[market]["monthly_forecast"],
            }
            for market in ("eu", "china")
        }
        print(json.dumps(compact, indent=2, ensure_ascii=False))
