"""Real-data contracts for baseline selection and positive forecast intervals."""

import unittest

from forecasting.load_data import load_weekly_market_data
from forecasting.pipeline import build_baseline_forecast


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


if __name__ == "__main__":
    unittest.main()
