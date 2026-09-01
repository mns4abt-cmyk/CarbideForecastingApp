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
from statsforecast import StatsForecast

from forecasting.backtest import MARKET_COLUMNS, run_all_backtests
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
        if model.__class__.__name__ == model_name:
            return model
    raise ValueError(f"Modell '{model_name}' ist nicht in default_models() enthalten.")


def _forecast_weekly(series: pd.DataFrame, unique_id: str, model_name: str) -> pd.DataFrame:
    """Fittet das ausgewählte Modell auf der Gesamthistorie, prognostiziert 52 Wochen inkl. 80%-Intervall."""
    sf_df = to_statsforecast_frame(series, unique_id, date_col="week", value_col="price")
    model = _select_model_instance(model_name)

    sf = StatsForecast(models=[model], freq=FREQ, n_jobs=1)
    fc_df = sf.forecast(df=sf_df, h=FORECAST_HORIZON_WEEKS, level=[INTERVAL_LEVEL])

    return fc_df.rename(
        columns={
            "ds": "week",
            model_name: "p50",
            f"{model_name}-lo-{INTERVAL_LEVEL}": "p10",
            f"{model_name}-hi-{INTERVAL_LEVEL}": "p90",
        }
    )[["week", "p10", "p50", "p90"]]


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

        logger.info(
            "Baue Baseline-Prognose für '%s' mit Modell '%s' (h=%d Wochen, Intervall=%d%%)",
            market, selected_model, FORECAST_HORIZON_WEEKS, INTERVAL_LEVEL,
        )

        weekly_forecast = _forecast_weekly(series, unique_id=market, model_name=selected_model)
        monthly_forecast = _monthly_forecast_frame(weekly_forecast, reference_month, FORECAST_MONTHS)
        last_row = series.iloc[-1]

        result[market] = {
            "selected_model": selected_model,
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
            "last_observed": baseline[market]["last_observed"],
            "p10": _reindex_forecast(market, "p10", forecast_months),
            "p50": _reindex_forecast(market, "p50", forecast_months),
            "p90": _reindex_forecast(market, "p90", forecast_months),
        }
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
