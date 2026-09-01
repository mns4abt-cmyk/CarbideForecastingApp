"""Untersucht, ob historische China-Preisbewegungen die EU-Prognose verbessern.

WICHTIG - Methodik:
    1. Korrelation ist rein deskriptiv/explorativ und beweist KEINE Kausalität.
       China und EU könnten beide auf einen gemeinsamen, hier nicht beobachteten
       Faktor reagieren (z.B. globale Rohstoffnachfrage) - eine positive
       Lead-Lag-Korrelation belegt für sich genommen keinen Wirkungszusammenhang.
    2. Korrelation allein ist NIEMALS eine hinreichende Begründung, ein Feature
       produktiv zu verwenden (siehe Auftrag). Die einzige akzeptierte
       Rechtfertigung ist eine tatsächliche, out-of-sample gemessene
       Verbesserung im Walk-Forward-Backtest - exakt derselbe Rahmen
       (Cutoffs, Horizonte, Fehlermetriken) wie in `forecasting.backtest`.
    3. Data-Leakage ist strikt verboten: jedes Feature und jedes Trainingsbeispiel
       verwendet ausschließlich zum jeweiligen Zeitpunkt bereits bekannte Werte;
       das direkte Mehrschritt-Regressionsziel y[t] = log(preis[t+h]) - log(preis[t])
       wird beim Training nur für Zeitpunkte t verwendet, deren Ergebnis (t+h)
       spätestens am jeweiligen Cutoff bereits eingetreten war.

Ablauf:
    lead_lag_correlations()      - corr(China-Rendite[t], EU-Rendite[t+lag]) für lag=0..8.
    build_feature_frame()        - China/EU-Renditen, -Volatilität, gelaggte China-Renditen.
    run_cross_market_experiment()- Baseline (aktuell gewähltes EU-Modell) vs. experimentelles
                                    Cross-Market-Ridge-Modell, identische Cutoffs/Horizonte/
                                    Metriken wie `forecasting.backtest`, inkl. Verbesserungs-%
                                    und automatischer Kandidaten-Entscheidung.

Eigenständig lauffähig: `python -m forecasting.cross_market` bzw.
`python forecasting/cross_market.py`.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd
from scipy.stats import pearsonr

from forecasting.backtest import (
    HORIZONS,
    MARKET_COLUMNS,
    _naive_scale_lookup,
    _prepare_market_series,
    compute_metrics,
    run_cross_validation,
    run_market_backtest,
)
from forecasting.direct_regression import run_direct_regression_backtest
from forecasting.load_data import load_weekly_market_data

logger = logging.getLogger(__name__)

MAX_LEAD_LAG_WEEKS = 8
VOL_WINDOW_WEEKS = 8
# Bewusst mehrere Lags als Kandidaten-Features angeboten (statt nur des laut Korrelation
# "besten" Lags), damit nicht die Korrelationsspitze selbst über die Modellwahl entscheidet -
# das überlässt der Regression + dem Backtest (siehe Modul-Docstring, Punkt 2).
CHINA_LAG_FEATURES_WEEKS = (1, 2, 4)
CROSS_MARKET_MODEL_NAME = "CrossMarketRidge"

FEATURE_COLUMNS = [
    "eu_ret_1w", "eu_ret_4w", "eu_vol",
    "china_ret_1w", "china_ret_4w", "china_vol",
    *[f"china_ret_1w_lag{lag}" for lag in CHINA_LAG_FEATURES_WEEKS],
]


def _weekly_log_returns(price: pd.Series) -> pd.Series:
    """Wöchentliche Log-Rendite; über Datenlücken hinweg entsteht bewusst NaN statt eines erfundenen Werts."""
    return np.log(price).diff()


def lead_lag_correlations(weekly_df: pd.DataFrame, max_lag: int = MAX_LEAD_LAG_WEEKS) -> list[dict]:
    """corr(China-Rendite[t], EU-Rendite[t+lag]) für lag = 0..max_lag Wochen.

    Liefert je Lag zusätzlich p-Wert und Stichprobengröße, damit eine schwache/
    nicht signifikante Korrelation nicht überinterpretiert werden kann. Rein
    explorativ - siehe Modul-Docstring, Punkt 1+2.
    """
    df = weekly_df.set_index("week").sort_index()
    china_ret = _weekly_log_returns(df[MARKET_COLUMNS["china"]])
    eu_ret = _weekly_log_returns(df[MARKET_COLUMNS["eu"]])

    rows = []
    for lag in range(0, max_lag + 1):
        eu_future = eu_ret.shift(-lag)
        pair = pd.concat([china_ret, eu_future], axis=1, keys=["china", "eu_future"]).dropna()
        n = len(pair)
        if n < 10:
            rows.append({"lag_weeks": lag, "corr": None, "p_value": None, "n_obs": n, "significant_5pct": False})
            continue
        r, p = pearsonr(pair["china"], pair["eu_future"])
        rows.append({
            "lag_weeks": lag,
            "corr": round(float(r), 4),
            "p_value": round(float(p), 4),
            "n_obs": n,
            "significant_5pct": bool(p < 0.05),
        })
    return rows


def build_feature_frame(weekly_df: pd.DataFrame, vol_window: int = VOL_WINDOW_WEEKS) -> pd.DataFrame:
    """Zeitpunktbezogene Cross-Market-Features, ausschließlich aus bis Woche `week` bekannten Werten.

    China hat laut `load_data.py` einzelne Wochen ohne Marktbeobachtung; für die
    Feature-Berechnung wird dies per Forward-Fill (ausschließlich Vergangenheitswerte,
    keine zukünftigen/erfundenen Beobachtungen) überbrückt.
    """
    df = weekly_df.set_index("week").sort_index()
    china_price = df[MARKET_COLUMNS["china"]].ffill()
    eu_price = df[MARKET_COLUMNS["eu"]]

    china_ret_1w = _weekly_log_returns(china_price)
    eu_ret_1w = _weekly_log_returns(eu_price)

    features = pd.DataFrame(index=df.index)
    features["eu_ret_1w"] = eu_ret_1w
    features["eu_ret_4w"] = np.log(eu_price) - np.log(eu_price.shift(4))
    features["eu_vol"] = eu_ret_1w.rolling(vol_window, min_periods=vol_window).std()
    features["china_ret_1w"] = china_ret_1w
    features["china_ret_4w"] = np.log(china_price) - np.log(china_price.shift(4))
    features["china_vol"] = china_ret_1w.rolling(vol_window, min_periods=vol_window).std()
    for lag in CHINA_LAG_FEATURES_WEEKS:
        features[f"china_ret_1w_lag{lag}"] = china_ret_1w.shift(lag)

    return features


def _decide_candidate(improvement_by_horizon: dict[int, dict]) -> bool:
    """Kandidat nur, wenn die MASE bei der Mehrheit der Horizonte tatsächlich sinkt (gleiche Logik wie `select_model()`)."""
    horizons = list(improvement_by_horizon.keys())
    wins = sum(1 for h in horizons if (improvement_by_horizon[h]["improvement_pct"] or 0) > 0)
    majority = len(horizons) // 2 + 1
    return wins >= majority


def run_cross_market_experiment(weekly_df: pd.DataFrame | None = None) -> dict:
    """Führt die vollständige Untersuchung durch: Korrelationen + Backtest-Vergleich.

    Returns:
        {
          "correlations": [...],
          "baseline": {"selected_model": str, "metrics": {horizon: metrics}},
          "cross_market": {"metrics": {horizon: metrics}},
          "improvement": {horizon: {"baseline_mase", "cross_market_mase", "improvement_pct"}},
          "candidate_approved": bool,
        }
    """
    weekly_df = load_weekly_market_data() if weekly_df is None else weekly_df

    correlations = lead_lag_correlations(weekly_df)

    baseline = run_market_backtest("eu", weekly_df)
    baseline_model_name = baseline["selected_model"]

    eu_series = _prepare_market_series(weekly_df, MARKET_COLUMNS["eu"])
    cv_df = run_cross_validation(eu_series, unique_id="eu").copy()
    scale_lookup = _naive_scale_lookup(eu_series)

    feature_frame = build_feature_frame(weekly_df)
    eu_price_grid = weekly_df.set_index("week")[MARKET_COLUMNS["eu"]].sort_index()

    cv_df = run_direct_regression_backtest(
        cv_df, feature_frame, eu_price_grid, FEATURE_COLUMNS, HORIZONS, CROSS_MARKET_MODEL_NAME
    )

    # Für das Cross-Market-Modell nur Zeilen mit tatsächlich vorhandener Vorhersage werten
    # (z.B. zu wenig Trainingsdaten am ersten Cutoff), damit fehlende Werte die Baseline-
    # Metriken nicht verfälschen.
    cm_cv_df = cv_df.dropna(subset=[CROSS_MARKET_MODEL_NAME])

    metrics_baseline = {h: compute_metrics(cv_df, scale_lookup, h, [baseline_model_name])[baseline_model_name] for h in HORIZONS}
    metrics_cross_market = {
        h: m for h in HORIZONS
        if (m := compute_metrics(cm_cv_df, scale_lookup, h, [CROSS_MARKET_MODEL_NAME]).get(CROSS_MARKET_MODEL_NAME))
    }

    improvement: dict[int, dict] = {}
    for h in HORIZONS:
        b_mase = metrics_baseline.get(h, {}).get("mase")
        c_mase = metrics_cross_market.get(h, {}).get("mase")
        improvement_pct = round((b_mase - c_mase) / b_mase * 100, 2) if b_mase and c_mase is not None and b_mase > 0 else None
        improvement[h] = {"baseline_mase": b_mase, "cross_market_mase": c_mase, "improvement_pct": improvement_pct}

    candidate_approved = _decide_candidate(improvement)

    return {
        "correlations": correlations,
        "baseline": {"selected_model": baseline_model_name, "metrics": metrics_baseline},
        "cross_market": {"model": CROSS_MARKET_MODEL_NAME, "metrics": metrics_cross_market},
        "improvement": improvement,
        "candidate_approved": candidate_approved,
    }


def _print_report(result: dict) -> None:
    print("\n=== Lead-Lag-Korrelation: corr(China-Rendite[t], EU-Rendite[t+lag]) ===")
    print("(Rein explorativ - KEIN Kausalitätsnachweis, siehe Modul-Docstring)")
    corr_table = pd.DataFrame(result["correlations"])
    print(corr_table.to_string(index=False))

    print(f"\n=== Baseline (aktuell produktiv gewähltes EU-Modell: {result['baseline']['selected_model']}) ===")
    for h in HORIZONS:
        m = result["baseline"]["metrics"].get(h, {})
        print(f"  h={h:>2} Wochen: MAE={m.get('mae'):.3f}  sMAPE={m.get('smape'):.2f}%  MASE={m.get('mase')}")

    print(f"\n=== Experimentelles Modell ({result['cross_market']['model']}, Cross-Market-Features) ===")
    for h in HORIZONS:
        m = result["cross_market"]["metrics"].get(h, {})
        if not m:
            print(f"  h={h:>2} Wochen: keine gültige Vorhersage (zu wenig Trainingsdaten)")
            continue
        print(f"  h={h:>2} Wochen: MAE={m.get('mae'):.3f}  sMAPE={m.get('smape'):.2f}%  MASE={m.get('mase')}")

    print("\n=== Verbesserung ggü. Baseline (MASE, positiv = Cross-Market-Modell besser) ===")
    for h in HORIZONS:
        v = result["improvement"][h]
        pct = v["improvement_pct"]
        pct_str = f"{pct:+.2f}%" if pct is not None else "n/a"
        print(f"  h={h:>2} Wochen: Baseline-MASE={v['baseline_mase']}  Cross-Market-MASE={v['cross_market_mase']}  Verbesserung={pct_str}")

    verdict = "JA - als Kandidatenmodell aufnehmen" if result["candidate_approved"] else "NEIN - Produktivmodell bleibt unverändert"
    print(f"\n=== Entscheidung (Mehrheit der Horizonte muss echte MASE-Verbesserung zeigen) ===\n{verdict}")


if __name__ == "__main__":
    import json

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    experiment_result = run_cross_market_experiment()
    _print_report(experiment_result)

    print("\n=== JSON-Ergebnis ===")
    print(json.dumps(experiment_result, indent=2, ensure_ascii=False, default=str))
