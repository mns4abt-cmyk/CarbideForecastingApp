"""Real-data contracts for baseline selection and positive forecast intervals."""

import unittest

from forecasting.load_data import load_weekly_market_data
from forecasting.pipeline import _forecast_horizons, build_baseline_forecast


class BaselineForecastTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.baseline = build_baseline_forecast(load_weekly_market_data())

    def test_positive_ordered_intervals_and_oos_metadata(self):
        for market in ("eu", "china"):
            result = self.baseline[market]
            self.assertIn(result["transformation"], {"raw", "log"})
            self.assertEqual(set(result["reliability"]), {"4w", "12w", "26w"})
            for reliability in result["reliability"].values():
                self.assertIn(reliability["label"], {"HIGH", "MEDIUM", "LOW", "VERY_LOW"})
                self.assertIn("maseDiagnostic", reliability)
            self.assertEqual(result["backtest"]["benchmark_key"], "Naive__raw")
            self.assertEqual(len(result["weekly_forecast"]), 52)
            for row in result["weekly_forecast"]:
                self.assertGreater(row["p10"], 0)
                self.assertLessEqual(row["p10"], row["p50"])
                self.assertLessEqual(row["p50"], row["p90"])

    def test_exact_horizon_checkpoints_use_weekly_forecast_positions(self):
        weekly = [
            {"p50": float(100 + week)}
            for week in range(1, 53)
        ]
        horizons = _forecast_horizons(weekly, 100.0)
        self.assertEqual(horizons["4w"], {"p50": 104.0, "changePct": 4.0})
        self.assertEqual(horizons["12w"], {"p50": 112.0, "changePct": 12.0})
        self.assertEqual(horizons["26w"], {"p50": 126.0, "changePct": 26.0})


if __name__ == "__main__":
    unittest.main()
