"""FX-Normalisierung: CNY/kg APT (China) <-> USD/mtu WO3 (EU) über historische USD/CNY-Kurse.

Datenquelle: EZB-Referenzkurse (offiziell, kostenlos, öffentlich):
    https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip
Die EZB veröffentlicht Kurse als "Einheiten Fremdwährung pro 1 EUR". Der benötigte
CNY-je-USD-Kurs wird daraus abgeleitet:
    cny_per_usd = (CNY je EUR) / (USD je EUR)

Umrechnung (1 mtu = 10 kg WO3-Äquivalent):
    china_usd_mtu   = china_cny_kg * 10 / cny_per_usd
    regional_ratio   = eu_usd_mtu / china_usd_mtu
    regional_spread  = eu_usd_mtu - china_usd_mtu   ("observed regional price differential")

WICHTIG: `regional_spread`/`regional_ratio` werden bewusst NICHT als "Arbitrage-Spanne"
bezeichnet - EU- und China-Benchmark können unterschiedliche Handelsbedingungen, Steuern,
Logistik, Lieferbedingungen oder Spezifikationen haben, sodass ein Preisunterschied allein
keine handelbare Arbitrage belegt.

Cache-Verhalten (siehe Auftrag):
    1. Historische Rohdaten werden programmatisch heruntergeladen.
    2. Ein lokaler Cache liegt in data/cache/.
    3. Bei "frischem" Cache (< CACHE_MAX_AGE_HOURS) wird NICHT erneut heruntergeladen.
    4. Schlägt der Netzwerk-Request fehl, wird auf den lokalen Cache zurückgefallen.
    5. Existiert weder aktueller Cache noch Netzwerk, wird KEIN Kurs erfunden -
       stattdessen `FxDataUnavailableError`.
    6. Die Anwendung bleibt auch ohne FX-Daten funktionsfähig: `build_normalized_market_data()`
       liefert dann unverändert die nativen Preisreihen zurück (siehe deren Docstring).

Dieses Modul testet außerdem (siehe `run_fx_feature_experiment()`), ob regional_ratio/
regional_spread die EU-Prognose im selben Walk-Forward-Rahmen wie `forecasting.backtest`
tatsächlich verbessern - Aufnahme in die produktive Pipeline erfolgt NUR bei
nachgewiesener Out-of-Sample-Verbesserung.

Eigenständig lauffähig: `python -m forecasting.fx` bzw. `python forecasting/fx.py`.
"""

from __future__ import annotations

import io
import logging
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

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

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = PROJECT_ROOT / "data" / "cache"
CACHE_CSV_PATH = CACHE_DIR / "ecb_eurofxref_hist.csv"

ECB_HIST_ZIP_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip"
CACHE_MAX_AGE_HOURS = 24
REQUEST_TIMEOUT_SECONDS = 15

MTU_PER_KG = 10  # 1 mtu = 10 kg WO3-Äquivalent
VOL_WINDOW_WEEKS = 8
FX_FEATURE_MODEL_NAME = "FxRatioSpreadRidge"

FEATURE_COLUMNS = [
    "eu_ret_1w", "eu_ret_4w", "eu_vol",
    "regional_ratio", "regional_ratio_chg_4w",
    "regional_spread", "regional_spread_chg_4w",
]


class FxDataUnavailableError(RuntimeError):
    """Weder aktueller Cache noch Netzwerk verfügbar - es wird bewusst kein Kurs erfunden."""


def _cache_is_fresh(path: Path, max_age_hours: float = CACHE_MAX_AGE_HOURS) -> bool:
    if not path.exists():
        return False
    age_hours = (pd.Timestamp.now() - pd.Timestamp(path.stat().st_mtime, unit="s")).total_seconds() / 3600
    return age_hours < max_age_hours


def _download_ecb_history() -> pd.DataFrame:
    """Lädt die vollständige EZB-Referenzkurs-Historie (täglich, alle Währungen je EUR)."""
    logger.info("Lade EZB-Referenzkurs-Historie von %s", ECB_HIST_ZIP_URL)
    with urllib.request.urlopen(ECB_HIST_ZIP_URL, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        raw_zip = response.read()

    with zipfile.ZipFile(io.BytesIO(raw_zip)) as zf:
        csv_name = next(name for name in zf.namelist() if name.endswith(".csv"))
        with zf.open(csv_name) as f:
            return pd.read_csv(f)


def _save_cache(df: pd.DataFrame) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(CACHE_CSV_PATH, index=False)
    logger.info("EZB-Referenzkurse in Cache geschrieben: %s (%d Zeilen)", CACHE_CSV_PATH, len(df))


def _load_cache() -> pd.DataFrame:
    if not CACHE_CSV_PATH.exists():
        raise FxDataUnavailableError(
            f"Kein FX-Cache vorhanden ({CACHE_CSV_PATH}) und Netzwerk nicht verfügbar - "
            "es wird bewusst kein Kurs erfunden."
        )
    logger.info("Nutze lokalen FX-Cache: %s", CACHE_CSV_PATH)
    return pd.read_csv(CACHE_CSV_PATH)


def _get_ecb_history(force_refresh: bool = False) -> pd.DataFrame:
    """Frischer Cache -> direkt nutzen; sonst Download versuchen, bei Netzwerkfehler auf
    (ggf. veralteten) Cache zurückfallen; ohne beides -> `FxDataUnavailableError`.
    """
    if not force_refresh and _cache_is_fresh(CACHE_CSV_PATH):
        logger.info("FX-Cache ist noch frisch (< %dh) - kein erneuter Download: %s", CACHE_MAX_AGE_HOURS, CACHE_CSV_PATH)
        return pd.read_csv(CACHE_CSV_PATH)

    try:
        df = _download_ecb_history()
        _save_cache(df)
        return df
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        logger.warning("EZB-Download fehlgeschlagen (%s) - falle auf lokalen Cache zurück.", exc)
        return _load_cache()


def load_cny_per_usd(force_refresh: bool = False) -> pd.DataFrame:
    """Liefert die tägliche CNY-je-USD-Reihe, abgeleitet aus EZB-EUR-Referenzkursen.

    Returns:
        DataFrame mit Spalten ["date" (datetime64), "cny_per_usd" (float)].

    Raises:
        FxDataUnavailableError: weder aktueller Cache noch Netzwerk verfügbar.
    """
    raw = _get_ecb_history(force_refresh=force_refresh)

    required = {"Date", "USD", "CNY"}
    missing = required - set(raw.columns)
    if missing:
        raise ValueError(f"Erwartete Spalten fehlen in EZB-Referenzkursdatei: {missing}")

    df = raw[["Date", "USD", "CNY"]].copy()
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df["USD"] = pd.to_numeric(df["USD"], errors="coerce")
    df["CNY"] = pd.to_numeric(df["CNY"], errors="coerce")
    df = df.dropna(subset=["Date", "USD", "CNY"])
    df = df[(df["USD"] > 0) & (df["CNY"] > 0)]

    df["cny_per_usd"] = df["CNY"] / df["USD"]
    df = df.rename(columns={"Date": "date"})[["date", "cny_per_usd"]]
    return df.sort_values("date").reset_index(drop=True)


def to_weekly_cny_per_usd(daily: pd.DataFrame, week_freq: str = "W-FRI") -> pd.DataFrame:
    """Resampled die tägliche cny_per_usd-Reihe auf Wochenbasis (letzter Kurs je Woche)."""
    s = daily.set_index("date")["cny_per_usd"].sort_index()
    weekly = s.resample(week_freq).last()
    weekly.index.name = "week"
    return weekly.reset_index()


def normalize_china_to_usd_mtu(weekly_df: pd.DataFrame, fx_weekly: pd.DataFrame) -> pd.DataFrame:
    """Ergänzt china_usd_mtu, regional_ratio, regional_spread; china_cny_kg bleibt erhalten.

    Wochen ohne FX-Kurs (z.B. FX-Reihe kürzer als Preis-Historie) bleiben NaN statt
    mit einem erfundenen Kurs aufgefüllt zu werden.
    """
    merged = weekly_df.merge(fx_weekly, on="week", how="left")
    merged["china_usd_mtu"] = merged["china_cny_kg"] * MTU_PER_KG / merged["cny_per_usd"]
    merged["regional_ratio"] = merged["eu_usd_mtu"] / merged["china_usd_mtu"]
    merged["regional_spread"] = merged["eu_usd_mtu"] - merged["china_usd_mtu"]
    return merged


def build_normalized_market_data(weekly_df: pd.DataFrame | None = None, force_refresh: bool = False) -> pd.DataFrame:
    """Best-effort: liefert `weekly_df` erweitert um FX-normalisierte Spalten.

    Ist keine FX-Historie verfügbar (Cache leer + Netzwerk down), wird dies nur geloggt -
    `weekly_df` wird unverändert (ohne die zusätzlichen Spalten) zurückgegeben, damit die
    Anwendung mit den nativen Preisreihen weiterarbeiten kann.
    """
    weekly_df = load_weekly_market_data() if weekly_df is None else weekly_df
    try:
        fx_daily = load_cny_per_usd(force_refresh=force_refresh)
    except FxDataUnavailableError as exc:
        logger.warning("FX-Normalisierung übersprungen, native Preisreihen bleiben unverändert nutzbar: %s", exc)
        return weekly_df.copy()

    fx_weekly = to_weekly_cny_per_usd(fx_daily)
    return normalize_china_to_usd_mtu(weekly_df, fx_weekly)


def _weekly_log_returns(price: pd.Series) -> pd.Series:
    """Wöchentliche Log-Rendite; über Datenlücken hinweg entsteht bewusst NaN statt eines erfundenen Werts."""
    return np.log(price).diff()


def build_feature_frame(normalized_df: pd.DataFrame, vol_window: int = VOL_WINDOW_WEEKS) -> pd.DataFrame:
    """Zeitpunktbezogene Features aus eigenen EU-Kennzahlen + regional_ratio/regional_spread.

    Nutzt ausschließlich bis Woche `week` bekannte Werte (Levels + deren 4-Wochen-
    Veränderung), keine zukünftigen/erfundenen Beobachtungen.
    """
    df = normalized_df.set_index("week").sort_index()
    eu_price = df[MARKET_COLUMNS["eu"]]
    eu_ret_1w = _weekly_log_returns(eu_price)

    features = pd.DataFrame(index=df.index)
    features["eu_ret_1w"] = eu_ret_1w
    features["eu_ret_4w"] = np.log(eu_price) - np.log(eu_price.shift(4))
    features["eu_vol"] = eu_ret_1w.rolling(vol_window, min_periods=vol_window).std()
    features["regional_ratio"] = df["regional_ratio"]
    features["regional_ratio_chg_4w"] = df["regional_ratio"] - df["regional_ratio"].shift(4)
    features["regional_spread"] = df["regional_spread"]
    features["regional_spread_chg_4w"] = df["regional_spread"] - df["regional_spread"].shift(4)

    return features


def _decide_candidate(improvement_by_horizon: dict[int, dict]) -> bool:
    """Kandidat nur, wenn die MASE bei der Mehrheit der Horizonte tatsächlich sinkt (gleiche Logik wie `select_model()`)."""
    horizons = list(improvement_by_horizon.keys())
    wins = sum(1 for h in horizons if (improvement_by_horizon[h]["improvement_pct"] or 0) > 0)
    majority = len(horizons) // 2 + 1
    return wins >= majority


def run_fx_feature_experiment(weekly_df: pd.DataFrame | None = None) -> dict:
    """Testet, ob regional_ratio/regional_spread die EU-Prognose out-of-sample verbessern.

    Nutzt exakt denselben Walk-Forward-Rahmen (Cutoffs/Horizonte/Metriken) wie
    `forecasting.backtest`, über den gemeinsamen `direct_regression`-Baustein.

    Returns:
        {
          "fx_available": bool,
          "baseline": {"selected_model": str, "metrics": {horizon: metrics}},
          "fx_feature_model": {"metrics": {horizon: metrics}},
          "improvement": {horizon: {...}},
          "candidate_approved": bool,
        } - falls FX-Daten nicht verfügbar sind, nur {"fx_available": False, "reason": str}.
    """
    weekly_df = load_weekly_market_data() if weekly_df is None else weekly_df
    normalized_df = build_normalized_market_data(weekly_df)

    if "regional_ratio" not in normalized_df.columns:
        reason = "Keine FX-Kurse verfügbar (weder frischer Cache noch Netzwerk) - Experiment übersprungen."
        logger.warning(reason)
        return {"fx_available": False, "reason": reason}

    baseline = run_market_backtest("eu", weekly_df)
    baseline_model_name = baseline["selected_model"]

    eu_series = _prepare_market_series(weekly_df, MARKET_COLUMNS["eu"])
    cv_df = run_cross_validation(eu_series, unique_id="eu").copy()
    scale_lookup = _naive_scale_lookup(eu_series)

    feature_frame = build_feature_frame(normalized_df)
    eu_price_grid = normalized_df.set_index("week")[MARKET_COLUMNS["eu"]].sort_index()

    cv_df = run_direct_regression_backtest(
        cv_df, feature_frame, eu_price_grid, FEATURE_COLUMNS, HORIZONS, FX_FEATURE_MODEL_NAME
    )

    # Nur Zeilen mit tatsächlich vorhandener Vorhersage werten (z.B. zu wenig
    # Trainingsdaten/fehlender FX-Kurs am ersten Cutoff), damit fehlende Werte die
    # Baseline-Metriken nicht verfälschen.
    fx_cv_df = cv_df.dropna(subset=[FX_FEATURE_MODEL_NAME])

    metrics_baseline = {h: compute_metrics(cv_df, scale_lookup, h, [baseline_model_name])[baseline_model_name] for h in HORIZONS}
    metrics_fx_model = {
        h: m for h in HORIZONS
        if (m := compute_metrics(fx_cv_df, scale_lookup, h, [FX_FEATURE_MODEL_NAME]).get(FX_FEATURE_MODEL_NAME))
    }

    improvement: dict[int, dict] = {}
    for h in HORIZONS:
        b_mase = metrics_baseline.get(h, {}).get("mase")
        c_mase = metrics_fx_model.get(h, {}).get("mase")
        improvement_pct = round((b_mase - c_mase) / b_mase * 100, 2) if b_mase and c_mase is not None and b_mase > 0 else None
        improvement[h] = {"baseline_mase": b_mase, "fx_model_mase": c_mase, "improvement_pct": improvement_pct}

    candidate_approved = _decide_candidate(improvement)

    return {
        "fx_available": True,
        "baseline": {"selected_model": baseline_model_name, "metrics": metrics_baseline},
        "fx_feature_model": {"model": FX_FEATURE_MODEL_NAME, "metrics": metrics_fx_model},
        "improvement": improvement,
        "candidate_approved": candidate_approved,
    }


def _print_report(result: dict) -> None:
    if not result.get("fx_available"):
        print(f"\nFX-Feature-Experiment übersprungen: {result.get('reason')}")
        return

    print(f"\n=== Baseline (aktuell produktiv gewähltes EU-Modell: {result['baseline']['selected_model']}) ===")
    for h in HORIZONS:
        m = result["baseline"]["metrics"].get(h, {})
        print(f"  h={h:>2} Wochen: MAE={m.get('mae'):.3f}  sMAPE={m.get('smape'):.2f}%  MASE={m.get('mase')}")

    print(f"\n=== Experimentelles Modell ({result['fx_feature_model']['model']}, regional_ratio/regional_spread) ===")
    for h in HORIZONS:
        m = result["fx_feature_model"]["metrics"].get(h, {})
        if not m:
            print(f"  h={h:>2} Wochen: keine gültige Vorhersage (zu wenig Trainingsdaten)")
            continue
        print(f"  h={h:>2} Wochen: MAE={m.get('mae'):.3f}  sMAPE={m.get('smape'):.2f}%  MASE={m.get('mase')}")

    print("\n=== Verbesserung ggü. Baseline (MASE, positiv = FX-Feature-Modell besser) ===")
    for h in HORIZONS:
        v = result["improvement"][h]
        pct = v["improvement_pct"]
        pct_str = f"{pct:+.2f}%" if pct is not None else "n/a"
        print(f"  h={h:>2} Wochen: Baseline-MASE={v['baseline_mase']}  FX-Modell-MASE={v['fx_model_mase']}  Verbesserung={pct_str}")

    verdict = "JA - als Kandidatenmodell aufnehmen" if result["candidate_approved"] else "NEIN - Produktivmodell bleibt unverändert"
    print(f"\n=== Entscheidung (Mehrheit der Horizonte muss echte MASE-Verbesserung zeigen) ===\n{verdict}")


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(description="FX-Normalisierung (China CNY/kg -> USD/mtu) + Feature-Backtest.")
    parser.add_argument("--force-refresh", action="store_true", help="EZB-Historie unabhängig vom Cache-Alter neu herunterladen.")
    parser.add_argument("--json", action="store_true", help="Nur das JSON-Ergebnis des Feature-Experiments ausgeben.")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s", stream=sys.stderr)

    weekly = load_weekly_market_data()
    normalized = build_normalized_market_data(weekly, force_refresh=args.force_refresh)

    if not args.json:
        if "regional_ratio" in normalized.columns:
            print("\n=== FX-normalisierte Wochendaten (letzte 8 Wochen) ===")
            cols = ["week", "eu_usd_mtu", "china_cny_kg", "china_usd_mtu", "regional_ratio", "regional_spread"]
            print(normalized[cols].tail(8).to_string(index=False))
        else:
            print("\nKeine FX-Normalisierung verfügbar - native Preisreihen (china_cny_kg/eu_usd_mtu) bleiben nutzbar.")

    experiment_result = run_fx_feature_experiment(weekly)
    if not args.json:
        _print_report(experiment_result)

    if args.json:
        print(json.dumps(experiment_result, indent=2, ensure_ascii=False, default=str))
