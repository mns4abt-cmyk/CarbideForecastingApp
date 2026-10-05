"""Content-addressed cache for deterministic model-selection backtests."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Callable

import pandas as pd

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CACHE_VERSION = 1
DEFAULT_CACHE_PATH = PROJECT_ROOT / ".cache" / "forecast-backtests-v1.json"
DEFAULT_INPUT_PATHS = (
    PROJECT_ROOT / "data" / "APT_Tungsten_EU.xlsx",
    PROJECT_ROOT / "data" / "APT_Tungsten_China.xlsx",
)
DEFAULT_CODE_PATHS = (
    PROJECT_ROOT / "forecasting" / "backtest.py",
    PROJECT_ROOT / "forecasting" / "models.py",
)


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cache_key(input_paths: tuple[Path, ...] = DEFAULT_INPUT_PATHS, code_paths: tuple[Path, ...] = DEFAULT_CODE_PATHS) -> str:
    """Fingerprint every workbook and algorithm file relevant to selection."""
    digest = hashlib.sha256(f"forecast-backtests:{CACHE_VERSION}".encode("utf-8"))
    for path in (*input_paths, *code_paths):
        digest.update(path.name.encode("utf-8"))
        digest.update(_file_digest(path).encode("ascii"))
    return digest.hexdigest()


def _restore_backtest_key_types(backtests: dict) -> dict:
    """Restore integer horizon keys lost during JSON serialization."""
    for result in backtests.values():
        if isinstance(result, dict) and isinstance(result.get("all_metrics"), dict):
            result["all_metrics"] = {int(horizon): metrics for horizon, metrics in result["all_metrics"].items()}
    return backtests


class BacktestCache:
    def __init__(
        self,
        cache_path: Path = DEFAULT_CACHE_PATH,
        input_paths: tuple[Path, ...] = DEFAULT_INPUT_PATHS,
        code_paths: tuple[Path, ...] = DEFAULT_CODE_PATHS,
    ) -> None:
        self.cache_path = cache_path
        self.input_paths = input_paths
        self.code_paths = code_paths

    def get_or_compute(self, weekly_df: pd.DataFrame, compute: Callable[[pd.DataFrame], dict]) -> tuple[dict, bool]:
        key = cache_key(self.input_paths, self.code_paths)
        try:
            with self.cache_path.open("r", encoding="utf-8") as handle:
                cached = json.load(handle)
            if cached.get("key") == key and isinstance(cached.get("backtests"), dict):
                logger.info("FORECAST_TIMING stage=walk_forward_backtest cache=hit duration_ms=0")
                return _restore_backtest_key_types(cached["backtests"]), True
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass

        result = compute(weekly_df)
        self._write({"version": CACHE_VERSION, "key": key, "backtests": result})
        return result, False

    def _write(self, value: dict) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile("w", encoding="utf-8", dir=self.cache_path.parent, delete=False) as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            temporary_path = Path(handle.name)
        try:
            os.replace(temporary_path, self.cache_path)
        finally:
            if temporary_path.exists():
                temporary_path.unlink(missing_ok=True)


_DEFAULT_CACHE = BacktestCache()


def get_cached_backtests(weekly_df: pd.DataFrame, compute: Callable[[pd.DataFrame], dict]) -> tuple[dict, bool]:
    return _DEFAULT_CACHE.get_or_compute(weekly_df, compute)
