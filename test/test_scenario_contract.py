"""Focused contract tests for Python-generated frontend scenarios."""

from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from forecasting.pipeline import build_frontend_scenarios
from forecasting.scenarios import HORIZONS_WEEKS, build_cumulative_return_path


class ScenarioContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        observed_weeks = pd.date_range("2023-09-01", periods=104, freq="W-FRI")
        china = 120 + np.linspace(0, 35, len(observed_weeks)) + np.sin(np.arange(len(observed_weeks))) * 3
        eu = 300 + np.linspace(0, 55, len(observed_weeks)) + np.cos(np.arange(len(observed_weeks))) * 5
        cls.weekly_df = pd.DataFrame({"week": observed_weeks, "china_cny_kg": china, "eu_usd_mtu": eu})

        forecast_weeks = pd.date_range(observed_weeks[-1] + pd.Timedelta(7, unit="D"), periods=52, freq="W-FRI")
        def market(last_price, model):
            p50 = [round(last_price * (1 + 0.002 * (i + 1)), 2) for i in range(52)]
            return {
                "selected_model": model,
                "last_observed": {"week": observed_weeks[-1].strftime("%Y-%m-%d"), "price": float(last_price)},
                "weekly_forecast": [
                    {"week": week.strftime("%Y-%m-%d"), "p10": value * .95, "p50": value, "p90": value * 1.05}
                    for week, value in zip(forecast_weeks, p50)
                ],
            }

        cls.baseline = {
            "china": market(float(china[-1]), "Naive"),
            "eu": market(float(eu[-1]), "AutoETS"),
        }
        cls.frontend_markets = {
            market: {"p50": [row["p50"] for row in values["weekly_forecast"] if pd.Timestamp(row["week"]).is_month_end]}
            for market, values in cls.baseline.items()
        }
        # Friday never reliably coincides with month end; use the same monthly-last rule as the pipeline.
        for market, values in cls.baseline.items():
            monthly = pd.DataFrame(values["weekly_forecast"])
            monthly["month"] = pd.to_datetime(monthly["week"]).dt.to_period("M")
            cls.frontend_markets[market]["p50"] = monthly.groupby("month").last()["p50"].head(12).tolist()

        cls.scenarios = build_frontend_scenarios(cls.weekly_df, cls.baseline, cls.frontend_markets)

    def test_baseline_is_the_unchanged_statistical_p50(self):
        baseline = next(item for item in self.scenarios if item["id"] == "base")
        self.assertEqual(baseline["kind"], "baseline")
        self.assertEqual(baseline["china"], self.frontend_markets["china"]["p50"])
        self.assertEqual(baseline["eu"], self.frontend_markets["eu"]["p50"])

    def test_fixed_scenarios_are_historical_quantile_stress_tests(self):
        by_id = {item["id"]: item for item in self.scenarios}
        self.assertTrue({"supplyShock", "demandSlowdown", "demandSurge", "euRegulation", "extremeExportStop", "extremeDemandCollapse"} <= by_id.keys())

        for scenario_id in ("supplyShock", "demandSlowdown"):
            scenario = by_id[scenario_id]
            self.assertEqual(scenario["kind"], "stress_test")
            self.assertEqual(scenario["metadata"]["method"], "historical_quantile")
            self.assertIn("quantile", scenario["metadata"])
            self.assertIn("effectiveSeverity", scenario["metadata"])

    def test_prices_and_changes_follow_the_display_contract(self):
        for scenario in self.scenarios:
            for market in ("china", "eu"):
                prices = scenario[market]
                self.assertEqual(len(prices), 12)
                self.assertTrue(all(price > 0 for price in prices))
                last_observed = self.baseline[market]["last_observed"]["price"]
                expected_change = round(((prices[-1] / last_observed) - 1) * 100, 1)
                self.assertEqual(scenario["expectedChange12m"][market], expected_change)

    def test_fixed_scenario_adjustments_are_directionally_consistent_at_every_horizon(self):
        by_id = {item["id"]: item for item in self.scenarios}
        expected_directions = {
            "supplyShock": "bullish",
            "demandSurge": "bullish",
            "euRegulation": "bullish",
            "demandSlowdown": "bearish",
            "extremeDemandCollapse": "bearish",
        }

        for scenario_id, direction in expected_directions.items():
            scenario = by_id[scenario_id]
            for market in ("china", "eu"):
                returns = {
                    int(horizon): value
                    for horizon, value in scenario["metadata"]["byMarket"][market]["targetReturnsByHorizonWeeks"].items()
                }
                path = build_cumulative_return_path(returns, 52)
                relevant = scenario["metadata"]["byMarket"][market]["relevance"] > 0
                if direction == "bullish" and relevant:
                    self.assertTrue(all(value >= -1e-12 for value in path))
                    self.assertTrue(all(returns[horizon] >= 0 for horizon in HORIZONS_WEEKS))
                if direction == "bearish":
                    self.assertTrue(all(value <= 1e-12 for value in path))
                    self.assertTrue(all(returns[horizon] <= 0 for horizon in HORIZONS_WEEKS))

    def test_directional_metadata_records_empirical_subset_or_conservative_fallback(self):
        for scenario in self.scenarios:
            if scenario["kind"] != "stress_test":
                continue
            for market in ("china", "eu"):
                calibration = scenario["metadata"]["byMarket"][market]["directionalCalibrationByHorizonWeeks"]
                for horizon in HORIZONS_WEEKS:
                    details = calibration[str(horizon)]
                    self.assertIn("directionalSampleSize", details)
                    self.assertIn("quantile", details)
                    self.assertIn("fallback", details)


if __name__ == "__main__":
    unittest.main()
