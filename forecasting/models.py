"""Statistische Zeitreihenmodelle für die APT-Wolfram-Preisprognose.

Nutzt ausschließlich klassische, gut erklärbare Zeitreihenverfahren aus
`statsforecast` (AutoARIMA, AutoETS, AutoTheta) sowie eine naive Baseline
(Random Walk) als verpflichtende Vergleichsgröße. Bewusst KEINE neuronalen/
Deep-Learning-Modelle (Chronos, PyTorch, TensorFlow, LightGBM, LLM-basierte
Prognosen) in dieser Ausbaustufe - siehe Projektauftrag.
"""

from __future__ import annotations

import logging

import pandas as pd
from statsforecast import StatsForecast
from statsforecast.models import AutoARIMA, AutoETS, AutoTheta, Naive

logger = logging.getLogger(__name__)

# Wochendaten ohne gesicherten wöchentlichen Saisonzyklus (Rohstoffpreis,
# kein Einzelhandels-/Nachfragemuster) -> nicht-saisonale Suche (=1).
# Kann später pro Markt kalibriert werden, falls eine Saisonalität belegt wird.
DEFAULT_SEASON_LENGTH = 1


def default_models(season_length: int = DEFAULT_SEASON_LENGTH) -> list:
    """Baut die Standard-Modellliste für die Prognose.

    Naive (Random Walk) ist immer Teil der Liste, da sie im Backtest als
    verpflichtende Baseline dient, gegen die die anspruchsvolleren Modelle
    sich beweisen müssen.

    Args:
        season_length: Anzahl Perioden pro Saisonzyklus (1 = nicht-saisonal).

    Returns:
        Liste instanziierter statsforecast-Modelle.
    """
    return [
        Naive(),
        AutoARIMA(season_length=season_length),
        AutoETS(season_length=season_length),
        AutoTheta(season_length=season_length),
    ]


def to_statsforecast_frame(df: pd.DataFrame, unique_id: str, date_col: str = "date", value_col: str = "price") -> pd.DataFrame:
    """Wandelt ein {date, price}-DataFrame in das von statsforecast erwartete Format um.

    Args:
        df: DataFrame mit Zeitstempel- und Preisspalte.
        unique_id: Kennung der Zeitreihe (z.B. "china" oder "eu").
        date_col: Name der Datumsspalte in `df`.
        value_col: Name der Preisspalte in `df`.

    Returns:
        DataFrame mit den von statsforecast benötigten Spalten
        ["unique_id", "ds", "y"].
    """
    out = df[[date_col, value_col]].rename(columns={date_col: "ds", value_col: "y"}).copy()
    out.insert(0, "unique_id", unique_id)
    return out


def forecast(
    df: pd.DataFrame,
    unique_id: str,
    periods: int = 12,
    freq: str = "W-FRI",
    date_col: str = "week",
    value_col: str = "price",
    models: list | None = None,
) -> pd.DataFrame:
    """Erstellt eine Punktprognose für die kommenden `periods` Wochen.

    Args:
        df: Wöchentliche Historie mit Spalten [date_col, value_col].
        unique_id: Kennung der Zeitreihe (z.B. "china" oder "eu").
        periods: Prognosehorizont in Perioden (Standard: 12 Wochen).
        freq: Pandas-Frequenzcode der Zeitreihe ("W-FRI" = Woche endet Freitag).
        date_col: Name der Datumsspalte in `df`.
        value_col: Name der Preisspalte in `df`.
        models: Optionale eigene Modellliste, sonst `default_models()`.

    Returns:
        DataFrame mit Spalten ["unique_id", "ds", <Modellname>, ...] - eine
        Zeile je Prognoseperiode, eine Spalte je Modell.
    """
    sf_df = to_statsforecast_frame(df, unique_id, date_col, value_col)
    used_models = models or default_models()

    logger.info(
        "Starte Prognose für '%s': %d Historienpunkte, Horizont=%d, Modelle=%s",
        unique_id, len(sf_df), periods, [m.__class__.__name__ for m in used_models],
    )

    sf = StatsForecast(models=used_models, freq=freq, n_jobs=1)
    forecast_df = sf.forecast(df=sf_df, h=periods)

    logger.info("Prognose für '%s' abgeschlossen: %d Zeilen", unique_id, len(forecast_df))
    return forecast_df
