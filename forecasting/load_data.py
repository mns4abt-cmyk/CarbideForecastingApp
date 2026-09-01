"""Einlesen der realen APT-Wolfram-Rohdaten aus data/*.xlsx.

Liest ausschließlich (niemals schreibend) aus:
    data/APT_Tungsten_EU.xlsx    - Long-Format, Spalten MaterialName/PriceDate/
                                    PriceUnit/Price/Description, Einheit "USD/mtu WO3".
    data/APT_Tungsten_China.xlsx - transponiertes Wide-Format, Zeilenlabel in
                                    Spalte 0 ("日期" = Datum, "MID" = Mid-Preis,
                                    "AVG YTD" = Year-to-Date-Durchschnitt).
                                    Verwendet wird ausschließlich die "MID"-Zeile.
                                    Einheit laut Fachbereich: "CNY/kg APT".

Beide Rohreihen werden auf ein gemeinsames Format {date, price} normalisiert,
bereinigt und anschließend unabhängig voneinander auf Wochenbasis (Woche endet
Freitag, "W-FRI") resampled, wobei je Woche die letzte tatsächlich vorhandene
Marktbeobachtung verwendet wird. Fehlende Wochen werden NICHT mit erfundenen
Werten aufgefüllt, sondern bleiben als NaN stehen.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)

# ---- Pfade relativ zum Projekt-Root auflösen (keine absoluten Pfade!) -----
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
EU_XLSX_PATH = DATA_DIR / "APT_Tungsten_EU.xlsx"
CHINA_XLSX_PATH = DATA_DIR / "APT_Tungsten_China.xlsx"

WEEK_FREQ = "W-FRI"
EXPECTED_EU_UNIT = "USD/mtu WO3"


def _clean_series(df: pd.DataFrame, label: str) -> pd.DataFrame:
    """Bereinigt ein rohes {date, price}-DataFrame nach den gemeinsamen Regeln.

    - date -> pandas datetime, price -> float.
    - Ungültige Zeilen (nicht parsbares Datum/Preis, Preis <= 0) werden entfernt.
    - Bei doppeltem Datum wird die zuletzt im Original vorkommende Zeile behalten.
    - Aufsteigend nach Datum sortiert.
    """
    out = df.copy()
    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    out["price"] = pd.to_numeric(out["price"], errors="coerce")

    before = len(out)
    out = out.dropna(subset=["date", "price"])
    out = out[out["price"] > 0]
    dropped = before - len(out)
    if dropped:
        logger.warning("%s: %d ungültige/unplausible Rohzeilen entfernt.", label, dropped)

    out = out.sort_values("date", kind="stable")
    dup_count = int(out["date"].duplicated(keep="last").sum())
    if dup_count:
        logger.warning("%s: %d doppelte Datumswerte gefunden, jeweils letzte Beobachtung behalten.", label, dup_count)
    out = out.drop_duplicates(subset="date", keep="last")

    return out.sort_values("date", kind="stable").reset_index(drop=True)[["date", "price"]]


def _validate_clean_series(df: pd.DataFrame, label: str) -> None:
    """Prüft eine bereinigte {date, price}-Reihe auf grundlegende Plausibilität."""
    if df.empty:
        raise ValueError(f"{label}: keine gültigen Datenpunkte nach der Bereinigung übrig.")
    if not df["date"].is_monotonic_increasing:
        raise ValueError(f"{label}: Datumsreihe ist nach der Sortierung nicht monoton steigend.")
    if (df["price"] <= 0).any():
        raise ValueError(f"{label}: es sind Preise <= 0 in der bereinigten Reihe enthalten.")


def load_eu_data(path: Path = EU_XLSX_PATH) -> pd.DataFrame:
    """Lädt und bereinigt die reale EU-APT-Preisreihe (Rotterdam/Baltimore-Benchmark, USD/mtu WO3).

    Args:
        path: Pfad zur EU-xlsx-Datei (Standard: data/APT_Tungsten_EU.xlsx).

    Returns:
        DataFrame mit Spalten ["date" (datetime64), "price" (float)],
        aufsteigend sortiert, ohne Duplikate/ungültige Zeilen.
    """
    if not path.exists():
        raise FileNotFoundError(f"EU-Rohdatendatei nicht gefunden: {path}")

    logger.info("Lade EU-Rohdaten (nur lesend) aus %s", path)
    raw = pd.read_excel(path, sheet_name="data_table", header=0, engine="openpyxl")

    required = {"PriceDate", "Price", "PriceUnit"}
    missing = required - set(raw.columns)
    if missing:
        raise ValueError(f"Erwartete Spalten fehlen in {path.name}: {missing}")

    units = raw["PriceUnit"].dropna().unique().tolist()
    if units and units != [EXPECTED_EU_UNIT]:
        logger.warning("Unerwartete/uneinheitliche PriceUnit-Werte in EU-Datei: %s (erwartet: %s)", units, EXPECTED_EU_UNIT)

    df = pd.DataFrame({"date": raw["PriceDate"], "price": raw["Price"]})
    df = _clean_series(df, "EU")
    _validate_clean_series(df, "EU")

    logger.info("EU-Rohdaten bereinigt: %d Beobachtungen, %s bis %s",
                len(df), df["date"].min().date(), df["date"].max().date())
    return df


def load_china_data(path: Path = CHINA_XLSX_PATH) -> pd.DataFrame:
    """Lädt und bereinigt die reale China-APT-Preisreihe ("MID"-Zeile, CNY/kg APT).

    Das Sheet ist transponiert: Spalte 0 enthält Zeilenlabels ("日期", "MID",
    "AVG YTD"), die eigentlichen Werte stehen ab Spalte 1. Es wird ausschließlich
    die "MID"-Zeile verwendet ("AVG YTD" ist eine per Excel-Formel fortgeschriebene
    Durchschnittsreihe und keine unabhängige Marktbeobachtung).

    Args:
        path: Pfad zur China-xlsx-Datei (Standard: data/APT_Tungsten_China.xlsx).

    Returns:
        DataFrame mit Spalten ["date" (datetime64), "price" (float)],
        aufsteigend sortiert, ohne Duplikate/ungültige Zeilen.
    """
    if not path.exists():
        raise FileNotFoundError(f"China-Rohdatendatei nicht gefunden: {path}")

    logger.info("Lade China-Rohdaten (nur lesend) aus %s", path)
    raw = pd.read_excel(path, sheet_name="Sheet1", header=None, engine="openpyxl")

    row_labels = raw.iloc[:, 0].astype(str).str.strip()
    date_rows = row_labels[row_labels == "日期"].index
    mid_rows = row_labels[row_labels == "MID"].index
    if len(date_rows) == 0 or len(mid_rows) == 0:
        raise ValueError(
            f"Erwartete Zeilenlabel '日期'/'MID' nicht in {path.name} gefunden "
            f"(gefundene Labels: {row_labels.tolist()})."
        )

    date_row = raw.iloc[date_rows[0], 1:]
    price_row = raw.iloc[mid_rows[0], 1:]

    df = pd.DataFrame({"date": date_row.to_numpy(), "price": price_row.to_numpy()})
    df = _clean_series(df, "China")
    _validate_clean_series(df, "China")

    logger.info("China-Rohdaten bereinigt: %d Beobachtungen, %s bis %s",
                len(df), df["date"].min().date(), df["date"].max().date())
    return df


def _to_weekly(df: pd.DataFrame, label: str) -> pd.DataFrame:
    """Resampled eine {date, price}-Reihe auf Wochenbasis (W-FRI, letzter Wert je Woche).

    Wochen ohne eigene Marktbeobachtung bleiben als NaN stehen (kein Forward-Fill,
    keine erfundenen Werte).
    """
    s = df.set_index("date")["price"].sort_index()
    weekly = s.resample(WEEK_FREQ).last()
    weekly.index.name = "week"
    result = weekly.reset_index()

    missing_weeks = int(result["price"].isna().sum())
    logger.info(
        "%s: %d Wochen (%s bis %s) nach Resampling auf %s, davon %d ohne Marktbeobachtung.",
        label, len(result), result["week"].min().date(), result["week"].max().date(),
        WEEK_FREQ, missing_weeks,
    )
    return result


def _validate_combined(df: pd.DataFrame) -> None:
    """Prüft den kombinierten wöchentlichen DataFrame auf grundlegende Plausibilität."""
    if df.empty:
        raise ValueError("Kombinierter wöchentlicher DataFrame ist leer.")
    if not df["week"].is_monotonic_increasing:
        raise ValueError("Wochenwerte im kombinierten DataFrame sind nicht monoton steigend.")
    if df["week"].duplicated().any():
        raise ValueError("Es existieren doppelte Wochenwerte im kombinierten DataFrame.")
    for col in ("eu_usd_mtu", "china_cny_kg"):
        present = df[col].dropna()
        if (present <= 0).any():
            raise ValueError(f"Spalte '{col}' enthält Werte <= 0.")


def _build_combined(eu_weekly: pd.DataFrame, china_weekly: pd.DataFrame) -> pd.DataFrame:
    """Führt die beiden wöchentlichen Reihen zu einem gemeinsamen DataFrame zusammen.

    Die Original-Datumsraster von EU und China müssen nicht übereinstimmen - es
    wird ein äußerer Verbund über die Woche gebildet, sodass beide Reihen ihren
    vollen jeweils eigenen Wertebereich behalten (fehlende Gegenseite = NaN).
    """
    combined = pd.merge(
        eu_weekly.rename(columns={"price": "eu_usd_mtu"}),
        china_weekly.rename(columns={"price": "china_cny_kg"}),
        on="week",
        how="outer",
    ).sort_values("week").reset_index(drop=True)

    _validate_combined(combined)
    return combined


def load_weekly_market_data() -> pd.DataFrame:
    """Lädt beide Rohreihen, bereinigt und resampled sie auf Wochenbasis und kombiniert sie.

    Returns:
        DataFrame mit Spalten ["week", "eu_usd_mtu", "china_cny_kg"], eine Zeile
        je Kalenderwoche (Wochenende Freitag), aufsteigend sortiert.
    """
    eu_weekly = _to_weekly(load_eu_data(), "EU")
    china_weekly = _to_weekly(load_china_data(), "China")
    return _build_combined(eu_weekly, china_weekly)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    eu_raw = load_eu_data()
    china_raw = load_china_data()
    eu_weekly = _to_weekly(eu_raw, "EU")
    china_weekly = _to_weekly(china_raw, "China")
    combined = _build_combined(eu_weekly, china_weekly)

    print("EU:")
    print(f"  start date: {eu_raw['date'].min().date()}")
    print(f"  end date: {eu_raw['date'].max().date()}")
    print(f"  raw observations: {len(eu_raw)}")
    print(f"  weekly observations: {len(eu_weekly)}")
    print(f"  last price: {eu_raw['price'].iloc[-1]}")
    print()
    print("China:")
    print(f"  start date: {china_raw['date'].min().date()}")
    print(f"  end date: {china_raw['date'].max().date()}")
    print(f"  raw observations: {len(china_raw)}")
    print(f"  weekly observations: {len(china_weekly)}")
    print(f"  last price: {china_raw['price'].iloc[-1]}")
    print()
    print("Combined weekly DataFrame (last 5 rows):")
    print(combined.tail(5).to_string(index=False))
