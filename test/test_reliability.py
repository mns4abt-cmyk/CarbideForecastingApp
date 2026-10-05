"""Focused deterministic tests for horizon-specific reliability labels."""

import unittest
import pandas as pd

from forecasting.pipeline import _assess_reliability


def backtest(selected, naive):
    metrics = {str(h): {**selected[str(h)], "n_obs": 6} for h in (4, 12, 26)}
    return {
        "metrics": metrics,
        "benchmark_key": "Naive__raw",
        "all_metrics": {h: {"Naive__raw": naive[str(h)]} for h in (4, 12, 26)},
    }


class ReliabilityTests(unittest.TestCase):
    def test_mase_alone_does_not_force_very_low(self):
        selected = {str(h): {"mae": 10, "smape": 10, "mase": 99, "mae_std": 2} for h in (4, 12, 26)}
        naive = {str(h): {"mae": 12} for h in (4, 12, 26)}
        series = pd.DataFrame({"price": [100, 100, 101, 101, 102]})
        labels = _assess_reliability(backtest(selected, naive), 100, series)
        self.assertTrue(all(value["label"] == "MEDIUM" for value in labels.values()))

    def test_horizon_specific_labels_follow_primary_inputs(self):
        selected = {
            "4": {"mae": 10, "smape": 10, "mase": 8, "mae_std": 2},
            "12": {"mae": 20, "smape": 20, "mase": 8, "mae_std": 5},
            "26": {"mae": 35, "smape": 30, "mase": 8, "mae_std": 5},
        }
        naive = {str(h): {"mae": 25} for h in (4, 12, 26)}
        series = pd.DataFrame({"price": [100, 100, 101, 101, 102]})
        labels = _assess_reliability(backtest(selected, naive), 100, series)
        self.assertEqual(labels["4w"]["label"], "MEDIUM")
        self.assertEqual(labels["12w"]["label"], "LOW")
        self.assertEqual(labels["26w"]["label"], "VERY_LOW")
