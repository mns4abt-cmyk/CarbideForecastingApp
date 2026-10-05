"""Forecasting-Engine für den Wolfram-Carbide Marktradar.

Dieses Package liest die realen APT-Wolfram-Rohdaten aus data/*.xlsx ein und
stellt statistische Zeitreihenprognosen bereit. Es ist bewusst unabhängig vom
Node/Express-Backend (server.js) und wird in einer späteren Ausbaustufe darüber
angebunden (z.B. via HTTP-Service oder Subprozess-Aufruf).

Module:
    load_data         - Excel-Rohdaten einlesen und auf Monatswerte resamplen.
    models            - Statistische Zeitreihenmodelle (statsforecast) bauen und anwenden.
    backtest          - Rolling-Origin-Backtesting und Fehlermetriken.
    pipeline          - Orchestriert load_data -> models -> backtest zu einem Gesamtlauf.
    cross_market      - Explorative Untersuchung, ob China-Marktdaten die EU-Prognose
                        verbessern (Lead-Lag-Korrelation + experimenteller,
                        backtest-validierter Cross-Market-Modellvergleich).
    fx                - FX-Normalisierung China (CNY/kg) <-> EU (USD/mtu) über EZB-Kurse
                        + backtest-validierter Test von regional_ratio/regional_spread.
    direct_regression - Gemeinsame Walk-Forward-Regressions-Infrastruktur für
                        `cross_market`/`fx` (kein eigenständiges Modul).
"""

__version__ = "0.1.0"
