"""Gemeinsame Infrastruktur für experimentelle "direkte" Mehrschritt-Regressionsmodelle.

Wird von mehreren experimentellen Modulen (`cross_market.py`, `fx.py`) genutzt, um
zusätzliche Features (Cross-Market-Kennzahlen, FX-normalisierte Kennzahlen, ...)
GENAU im selben Walk-Forward-Rahmen (Cutoffs/Horizonte/Metriken aus
`forecasting.backtest`) gegen die produktive Baseline zu testen, ohne die
Backtest-Schleife je Modul neu zu implementieren.

Data-Leakage ist strikt ausgeschlossen: das Regressionsziel y[t] = log(preis[t+h])
- log(preis[t]) wird beim Training nur für Zeitpunkte t verwendet, deren Ergebnis
(t+h) spätestens am jeweiligen Cutoff bereits eingetreten war (echtes
Expanding-Window, je Cutoff/Horizont ein frisch gefittetes Modell).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.linear_model import RidgeCV
from sklearn.preprocessing import StandardScaler

RIDGE_ALPHAS = (0.1, 1.0, 10.0, 100.0)
MIN_TRAIN_ROWS = 40


class DirectRidgeModel:
    """Sagt für einen Horizont `h` direkt die kumulierte Log-Rendite von Woche `t` bis
    `t+h` voraus (aus zum Zeitpunkt `t` bekannten Features), statt wie AutoARIMA/AutoETS/
    AutoTheta rekursiv Woche für Woche fortzuschreiben.
    """

    def __init__(
        self,
        feature_columns: list[str],
        alphas: tuple[float, ...] = RIDGE_ALPHAS,
        min_train_rows: int = MIN_TRAIN_ROWS,
    ):
        self.feature_columns = feature_columns
        self.alphas = alphas
        self.min_train_rows = min_train_rows

    def fit_predict(self, feature_frame: pd.DataFrame, price: pd.Series, cutoff_pos: int, horizon: int) -> float | None:
        """Fittet auf allen bis zum Cutoff bereits realisierten (t, t+h)-Beispielen und sagt Woche `cutoff_pos+h` voraus."""
        targets = np.log(price.shift(-horizon)) - np.log(price)

        train_end_pos = cutoff_pos - horizon  # letzter Zeitpunkt, dessen Ziel (t+h) <= cutoff bereits bekannt ist
        if train_end_pos < 0:
            return None

        train_df = pd.concat(
            [feature_frame.iloc[: train_end_pos + 1], targets.iloc[: train_end_pos + 1].rename("y")], axis=1
        ).dropna()
        if len(train_df) < self.min_train_rows:
            return None

        x_cutoff = feature_frame.iloc[cutoff_pos][self.feature_columns]
        if x_cutoff.isna().any():
            return None

        scaler = StandardScaler().fit(train_df[self.feature_columns].to_numpy())
        model = RidgeCV(alphas=self.alphas)
        model.fit(scaler.transform(train_df[self.feature_columns].to_numpy()), train_df["y"].to_numpy())

        pred_return = model.predict(scaler.transform(x_cutoff.to_numpy().reshape(1, -1)))[0]
        price_at_cutoff = float(price.iloc[cutoff_pos])
        return price_at_cutoff * float(np.exp(pred_return))


def run_direct_regression_backtest(
    cv_df: pd.DataFrame,
    feature_frame: pd.DataFrame,
    price: pd.Series,
    feature_columns: list[str],
    horizons: tuple[int, ...],
    model_col_name: str,
    alphas: tuple[float, ...] = RIDGE_ALPHAS,
    min_train_rows: int = MIN_TRAIN_ROWS,
) -> pd.DataFrame:
    """Füllt eine Kopie von `cv_df[model_col_name]` mit den DirectRidgeModel-Vorhersagen je (Cutoff, Horizont).

    `cv_df` muss die Spalten "cutoff"/"ds" aus `backtest.run_cross_validation()` enthalten;
    `feature_frame`/`price` müssen denselben durchgängigen wöchentlichen Index verwenden, auf
    dem die `cutoff`-Zeitstempel per `.get_loc()` auffindbar sind.
    """
    out = cv_df.copy()
    out[model_col_name] = np.nan
    model = DirectRidgeModel(feature_columns, alphas=alphas, min_train_rows=min_train_rows)

    step_weeks = (out["ds"] - out["cutoff"]).dt.days // 7
    for cutoff in sorted(out["cutoff"].unique()):
        cutoff_pos = feature_frame.index.get_loc(cutoff)
        for horizon in horizons:
            pred = model.fit_predict(feature_frame, price, cutoff_pos, horizon)
            if pred is None:
                continue
            row_mask = (out["cutoff"] == cutoff) & (step_weeks == horizon)
            out.loc[row_mask, model_col_name] = pred

    return out
