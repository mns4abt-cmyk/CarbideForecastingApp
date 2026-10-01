"""Contract tests for deterministic, content-addressed backtest caching."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import pandas as pd
import numpy as np

from forecasting.backtest import interval_error_samples
from forecasting.backtest_cache import BacktestCache


class BacktestCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self.temporary_directory.name)
        self.input_path = root / "input.xlsx"
        self.code_path = root / "backtest.py"
        self.input_path.write_bytes(b"workbook-v1")
        self.code_path.write_text("algorithm-v1", encoding="utf-8")
        self.cache = BacktestCache(root / "cache.json", (self.input_path,), (self.code_path,))
        self.weekly_df = pd.DataFrame({"week": pd.date_range("2026-01-02", periods=2, freq="W-FRI"), "price": [1.0, 2.0]})

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_unchanged_inputs_reuse_exact_backtest_result(self):
        expected = {"eu": {"selected_model": "Naive", "metrics": {"4": {"mae": 1.25}}, "all_metrics": {4: {"Naive__raw": {"mae": 1.25}}}}}
        calls = []

        def compute(frame):
            calls.append(frame)
            return expected

        first, first_hit = self.cache.get_or_compute(self.weekly_df, compute)
        second, second_hit = self.cache.get_or_compute(self.weekly_df, compute)

        self.assertEqual(first, expected)
        self.assertEqual(second, expected)
        self.assertFalse(first_hit)
        self.assertTrue(second_hit)
        self.assertEqual(calls, [self.weekly_df])
        self.assertIn(4, second["eu"]["all_metrics"])

    def test_workbook_or_algorithm_change_invalidates_cache(self):
        calls = []

        def compute(_frame):
            calls.append(len(calls))
            return {"call": calls[-1]}

        self.cache.get_or_compute(self.weekly_df, compute)
        self.input_path.write_bytes(b"workbook-v2")
        after_workbook_change, workbook_hit = self.cache.get_or_compute(self.weekly_df, compute)
        self.code_path.write_text("algorithm-v2", encoding="utf-8")
        after_code_change, code_hit = self.cache.get_or_compute(self.weekly_df, compute)

        self.assertFalse(workbook_hit)
        self.assertFalse(code_hit)
        self.assertEqual(after_workbook_change, {"call": 1})
        self.assertEqual(after_code_change, {"call": 2})

    def test_interval_samples_reuse_the_same_walk_forward_residuals(self):
        cv_df = pd.DataFrame({
            "cutoff": pd.to_datetime(["2026-01-02", "2026-01-02", "2026-01-09"]),
            "ds": pd.to_datetime(["2026-01-09", "2026-01-16", "2026-01-16"]),
            "y": [100.0, 110.0, 120.0],
            "Naive": [95.0, 100.0, 100.0],
        })
        samples = interval_error_samples(cv_df, "Naive")
        self.assertAlmostEqual(samples["1"][0], float(np.log(100 / 95)))
        self.assertAlmostEqual(samples["2"][0], float(np.log(110 / 100)))
        self.assertAlmostEqual(samples["1"][1], float(np.log(120 / 100)))
