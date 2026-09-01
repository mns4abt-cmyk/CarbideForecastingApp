"""Walk-Forward-Backtesting zur begründeten Modellauswahl je Markt.

Vergleicht Naive (Random Walk), AutoARIMA, AutoETS und AutoTheta anhand
echter Rolling-/Expanding-Window-Kreuzvalidierung (`StatsForecast.cross_validation`)
auf den wöchentlichen EU- und China-Preisreihen. An jedem Testursprung
("cutoff") nutzen die Modelle ausschließlich Beobachtungen, die zu diesem
Zeitpunkt tatsächlich bereits bekannt gewesen wären - `cross_validation`
trainiert für jedes Fenster ausschließlich auf den davorliegenden Daten,
es fließen keine späteren Werte in Training oder Skalierung ein.

Naive ist verpflichtender Vergleichsmaßstab: ein komplexeres Modell wird nur
dann für den produktiven Einsatz ausgewählt, wenn es Naive über die Mehrzahl
der geprüften Horizonte hinweg tatsächlich schlägt (siehe `select_model()`).
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd
from statsforecast import StatsForecast

from forecasting.load_data import load_weekly_market_data
from forecasting.models import DEFAULT_SEASON_LENGTH, default_models, to_statsforecast_frame

logger = logging.getLogger(__name__)

FREQ = "W-FRI"
HORIZONS: tuple[int, ...] = (4, 12, 26)
MAX_HORIZON = max(HORIZONS)
N_WINDOWS = 6
STEP_SIZE = 4

MARKET_COLUMNS = {"eu": "eu_usd_mtu", "china": "china_cny_kg"}


def _prepare_market_series(weekly_df: pd.DataFrame, value_col: str) -> pd.DataFrame:
    """Extrahiert eine lückenlose {week, price}-Reihe für einen Markt.

    Wochen ohne Marktbeobachtung (NaN) werden entfernt statt aufgefüllt, damit
    kein erfundener Preis in Training oder Bewertung einfließt.
    """
    out = weekly_df[["week", value_col]].dropna().rename(columns={value_col: "price"})
    return out.sort_values("week").reset_index(drop=True)


def _naive_scale_lookup(series: pd.DataFrame) -> pd.Series:
    """Baut die zeitpunktbezogene MASE-Skala (expandierende In-Sample-Naive-MAE).

    Für einen Testursprung `cutoff` liefert `scale.asof(cutoff)` die mittlere
    absolute Wochenänderung, die ausschließlich aus bis dahin bekannten
    Beobachtungen berechnet wurde - kein Blick in die Zukunft.
    """
    s = series.set_index("week")["price"].sort_index()
    return s.diff().abs().expanding(min_periods=2).mean()


def run_cross_validation(series: pd.DataFrame, unique_id: str, models: list | None = None) -> pd.DataFrame:
    """Führt eine Walk-Forward-Kreuzvalidierung über `MAX_HORIZON` Wochen durch.

    Args:
        series: Lückenlose wöchentliche Historie mit Spalten ["week", "price"].
        unique_id: Kennung der Zeitreihe ("eu" oder "china").
        models: Optionale eigene Modellliste, sonst `default_models()`.

    Returns:
        Rohes `cross_validation`-Ergebnis (Spalten u.a. "cutoff", "ds", "y"
        sowie je eine Spalte pro Modell) - eine Zeile je (Fenster, Vorlaufwoche).

    Raises:
        ValueError: Wenn die Historie zu kurz für die konfigurierten Fenster ist.
    """
    sf_df = to_statsforecast_frame(series, unique_id, date_col="week", value_col="price")
    used_models = models or default_models(season_length=DEFAULT_SEASON_LENGTH)

    min_required = MAX_HORIZON + (N_WINDOWS - 1) * STEP_SIZE + 10
    if len(sf_df) < min_required:
        raise ValueError(
            f"Zu wenig Historie für Backtest von '{unique_id}': {len(sf_df)} Wochen vorhanden, "
            f"empfohlen mindestens {min_required}."
        )

    logger.info(
        "Starte Walk-Forward-Backtest für '%s': %d Wochen Historie, h=%d, n_windows=%d, step_size=%d, Modelle=%s",
        unique_id, len(sf_df), MAX_HORIZON, N_WINDOWS, STEP_SIZE,
        [m.__class__.__name__ for m in used_models],
    )

    sf = StatsForecast(models=used_models, freq=FREQ, n_jobs=1)
    cv_df = sf.cross_validation(df=sf_df, h=MAX_HORIZON, n_windows=N_WINDOWS, step_size=STEP_SIZE)

    logger.info(
        "Backtest für '%s' abgeschlossen: %d Zeilen über %d Testfenster",
        unique_id, len(cv_df), cv_df["cutoff"].nunique(),
    )
    return cv_df


def _smape(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """Symmetrischer MAPE in Prozent, 0 bei beidseitig exakt Null statt Division durch Null."""
    denom = np.abs(y_true) + np.abs(y_pred)
    ratio = np.where(denom == 0, 0.0, 200.0 * np.abs(y_true - y_pred) / np.where(denom == 0, 1.0, denom))
    return float(np.mean(ratio))


def compute_metrics(
    cv_df: pd.DataFrame,
    scale_lookup: pd.Series,
    horizon: int,
    model_names: list[str],
) -> dict[str, dict[str, float]]:
    """Berechnet MAE/sMAPE/MASE je Modell für exakt `horizon` Wochen Vorlaufzeit.

    Es wird bewusst nur die Vorhersage AN Woche `horizon` bewertet (nicht der
    kumulierte Durchschnitt über 1..horizon), damit z.B. "12 Wochen voraus"
    auch tatsächlich diesen Vorlauf misst.

    Args:
        cv_df: Ergebnis von `run_cross_validation()`.
        scale_lookup: Ergebnis von `_naive_scale_lookup()` derselben Reihe.
        horizon: Vorlaufzeit in Wochen (muss in `HORIZONS` enthalten sein).
        model_names: Zu bewertende Modellspalten.

    Returns:
        Dict je Modellname mit "mae", "smape" (%), "mase" (None falls nicht
        berechenbar) und "n_obs" (Anzahl bewerteter Testpunkte).
    """
    step_weeks = (cv_df["ds"] - cv_df["cutoff"]).dt.days // 7
    subset = cv_df[step_weeks == horizon].copy()

    if subset.empty:
        logger.warning("Keine Kreuzvalidierungs-Zeilen für Horizont=%d Wochen gefunden.", horizon)
        return {}

    subset["scale"] = subset["cutoff"].map(scale_lookup.asof)
    y_true = subset["y"].to_numpy()

    metrics: dict[str, dict[str, float]] = {}
    for name in model_names:
        if name not in subset.columns:
            continue
        y_pred = subset[name].to_numpy()

        mae = float(np.mean(np.abs(y_true - y_pred)))
        smape = _smape(y_true, y_pred)

        scale = subset["scale"].replace(0, np.nan).to_numpy()
        with np.errstate(invalid="ignore"):
            mase_values = np.abs(y_true - y_pred) / scale
        mase = float(np.nanmean(mase_values)) if np.any(~np.isnan(mase_values)) else None

        metrics[name] = {"mae": mae, "smape": smape, "mase": mase, "n_obs": int(len(subset))}

    return metrics


def select_model(metrics_by_horizon: dict[int, dict[str, dict]]) -> tuple[str, dict]:
    """Wählt ein Modell je Markt anhand konsistenter Überlegenheit ggü. Naive.

    Ein anspruchsvolleres Modell wird nur dann Kandidat, wenn seine MASE bei
    der Mehrheit der geprüften Horizonte niedriger als die von Naive ist.
    Unter den Kandidaten gewinnt die niedrigste über alle Horizonte gemittelte
    MASE. Gibt es keinen Kandidaten, bleibt Naive die Wahl - ein komplexeres
    Modell gilt nicht automatisch als besser, nur weil es aufwendiger ist.

    Args:
        metrics_by_horizon: {horizon_wochen: {modellname: metrics_dict}}.

    Returns:
        Tupel (ausgewähltes_modell, {horizon_wochen_als_str: metrics_dict}).
    """
    horizons = sorted(metrics_by_horizon.keys())
    model_names = {name for h_metrics in metrics_by_horizon.values() for name in h_metrics}
    challengers = sorted(model_names - {"Naive"})

    wins = {name: 0 for name in challengers}
    for h in horizons:
        naive_mase = metrics_by_horizon[h].get("Naive", {}).get("mase")
        if naive_mase is None:
            continue
        for name in challengers:
            model_mase = metrics_by_horizon[h].get(name, {}).get("mase")
            if model_mase is not None and model_mase < naive_mase:
                wins[name] += 1

    majority = len(horizons) // 2 + 1
    candidates = [name for name, w in wins.items() if w >= majority]

    def _overall_mase(name: str) -> float:
        values = [metrics_by_horizon[h].get(name, {}).get("mase") for h in horizons]
        values = [v for v in values if v is not None]
        return sum(values) / len(values) if values else float("inf")

    selected = min(candidates, key=_overall_mase) if candidates else "Naive"

    logger.info(
        "Modellauswahl: Siege ggü. Naive je Modell=%s, Mehrheitsschwelle=%d, gewählt='%s'",
        wins, majority, selected,
    )

    summary_metrics = {str(h): metrics_by_horizon[h].get(selected, {}) for h in horizons}
    return selected, summary_metrics


def run_market_backtest(market: str, weekly_df: pd.DataFrame) -> dict:
    """Führt den vollständigen Backtest + Modellauswahl für einen Markt durch.

    Args:
        market: "eu" oder "china".
        weekly_df: Ergebnis von `load_weekly_market_data()`.

    Returns:
        Dict mit "selected_model", "metrics" (Metriken des gewählten Modells
        je Horizont) und "all_metrics" (alle Modelle je Horizont, für die
        Ergebnistabelle).
    """
    value_col = MARKET_COLUMNS[market]
    series = _prepare_market_series(weekly_df, value_col)
    models = default_models(season_length=DEFAULT_SEASON_LENGTH)
    model_names = [m.__class__.__name__ for m in models]

    cv_df = run_cross_validation(series, unique_id=market, models=models)
    scale_lookup = _naive_scale_lookup(series)

    metrics_by_horizon = {h: compute_metrics(cv_df, scale_lookup, h, model_names) for h in HORIZONS}
    selected_model, summary_metrics = select_model(metrics_by_horizon)

    return {
        "selected_model": selected_model,
        "metrics": summary_metrics,
        "all_metrics": metrics_by_horizon,
    }


def run_all_backtests() -> dict:
    """Führt den Backtest für EU und China durch und liefert die Auswahl je Markt."""
    weekly_df = load_weekly_market_data()
    return {market: run_market_backtest(market, weekly_df) for market in MARKET_COLUMNS}


def _print_results_table(results: dict) -> None:
    rows = []
    for market, res in results.items():
        for horizon, model_metrics in res["all_metrics"].items():
            for model_name, vals in model_metrics.items():
                rows.append(
                    {
                        "market": market,
                        "horizon_weeks": horizon,
                        "model": model_name,
                        "mae": round(vals["mae"], 3),
                        "smape_%": round(vals["smape"], 2),
                        "mase": round(vals["mase"], 3) if vals["mase"] is not None else None,
                        "n_obs": vals["n_obs"],
                    }
                )

    table = pd.DataFrame(rows).sort_values(["market", "horizon_weeks", "mase"], na_position="last")
    print("\n=== Walk-Forward-Backtest: Ergebnistabelle (MASE < 1 schlägt Naive) ===")
    print(table.to_string(index=False))


if __name__ == "__main__":
    import json

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    backtest_results = run_all_backtests()
    _print_results_table(backtest_results)

    selection = {
        market: {"selected_model": res["selected_model"], "metrics": res["metrics"]}
        for market, res in backtest_results.items()
    }
    print("\n=== Modellauswahl ===")
    print(json.dumps(selection, indent=2, ensure_ascii=False, default=str))
