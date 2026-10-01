"""Exports the existing normalized weekly price series for local Node jobs.

This is intentionally a thin adapter around load_weekly_market_data(): all
Excel parsing, cleaning, and Friday-ending resampling remains owned by
forecasting.load_data. Output is JSON only; it does not fit models or build
forecasts/scenarios.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from forecasting.load_data import load_weekly_market_data


def normalized_weekly_records() -> list[dict]:
    weekly = load_weekly_market_data()
    records = []
    for _, row in weekly.iterrows():
        records.append({
            "week": row["week"].strftime("%Y-%m-%d"),
            "eu_usd_mtu": None if not row["eu_usd_mtu"] == row["eu_usd_mtu"] else float(row["eu_usd_mtu"]),
            "china_cny_kg": None if not row["china_cny_kg"] == row["china_cny_kg"] else float(row["china_cny_kg"]),
        })
    return records


if __name__ == "__main__":
    print(json.dumps(normalized_weekly_records(), ensure_ascii=False))
