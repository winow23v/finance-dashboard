"""Collect paired Yahoo Finance daily bars for local research only."""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import json
import logging
from pathlib import Path
import tempfile
from shutil import rmtree
from time import monotonic, sleep
from uuid import uuid4

import exchange_calendars as xcals
import numpy as np
import pandas as pd
import yfinance as yf
from curl_cffi.requests.exceptions import RequestException
from yfinance.exceptions import YFPricesMissingError, YFRateLimitError

from indicators import calculate

yf.config.debug.hide_exceptions = False

STOCKS = {
    "AAPL": "XNAS", "MSFT": "XNAS", "NVDA": "XNAS", "GOOGL": "XNAS",
    "AMZN": "XNAS", "DELL": "XNYS", "KO": "XNYS", "JNJ": "XNYS", "PG": "XNYS",
}
SYMBOLS = {**STOCKS, "^GSPC": "INDEX", "^IXIC": "INDEX", "^DJI": "INDEX"}
DEFAULT_SYMBOLS = ("KO", "JNJ", "PG")
PRICE_COLUMNS = ["Open", "High", "Low", "Close"]
COLUMNS = [*PRICE_COLUMNS, "Volume"]
ZONE = "America/New_York"


class DataError(ValueError):
    pass


class EmptyData(DataError):
    pass


class RateLimited(DataError):
    pass


def normalize(frame, symbol):
    if frame is None or frame.empty:
        raise EmptyData("empty-response")
    frame = frame.copy()
    if isinstance(frame.columns, pd.MultiIndex):
        levels = [i for i in range(frame.columns.nlevels) if symbol in frame.columns.get_level_values(i)]
        if len(levels) != 1:
            raise DataError("ambiguous-symbol-columns")
        frame = frame.xs(symbol, axis=1, level=levels[0])
    if not frame.columns.is_unique or not set(COLUMNS).issubset(frame.columns):
        raise DataError("invalid-ohlcv-columns")
    frame = frame[COLUMNS].apply(pd.to_numeric, errors="coerce")
    if not isinstance(frame.index, pd.DatetimeIndex) or frame.index.hasnans:
        raise DataError("invalid-session-date")
    if frame.index.tz is not None:
        frame.index = frame.index.tz_convert(ZONE).tz_localize(None)
    frame.index = frame.index.normalize().rename("Date")
    if frame.index.has_duplicates:
        raise DataError("duplicate-session-date")
    frame = frame.sort_index()
    if pd.isna(frame["Close"].iloc[-1]):
        logging.warning("%s trailing row missing Close, excluded", symbol)
        frame = frame.iloc[:-1]
    if frame.empty:
        raise EmptyData("no-usable-bars")
    if frame["Close"].isna().any():
        raise DataError("missing-close")
    if frame["Volume"].isna().any():
        raise DataError("missing-volume")
    if not np.isfinite(frame.to_numpy()).all() or (frame[PRICE_COLUMNS] <= 0).any().any():
        raise DataError("invalid-price-or-volume")
    if (frame["Volume"] < 0).any() or (frame["Volume"] % 1 != 0).any():
        raise DataError("invalid-volume")
    if (frame["High"] < frame[["Open", "Close", "Low"]].max(axis=1)).any() or (
        frame["Low"] > frame[["Open", "Close"]].min(axis=1)
    ).any():
        raise DataError("inconsistent-ohlc")
    frame["Volume"] = frame["Volume"].astype("int64")
    return frame


@dataclass
class Downloader:
    minimum_interval: float = 2.0
    attempts: int = 3
    next_request: float = 0.0

    def history(self, symbol, adjusted):
        for attempt in range(self.attempts):
            sleep(max(0, self.next_request - monotonic()))
            try:
                # One ticker at a time. Ticker.history propagates classified provider errors.
                self.ticker = yf.Ticker(symbol)
                frame = self.ticker.history(
                    interval="1d", period="2y", auto_adjust=adjusted, keepna=True,
                    timeout=12,
                )
                return normalize(frame, symbol)
            except YFRateLimitError:
                category, delay = "rate-limited", 15
            except (YFPricesMissingError, EmptyData):
                category, delay = "empty-response", 2
            except (RequestException, ConnectionError, TimeoutError):
                category, delay = "connection-failure", 2
            finally:
                self.next_request = monotonic() + self.minimum_interval
            logging.warning("%s adjusted=%s attempt=%s %s", symbol, adjusted, attempt + 1, category)
            if attempt + 1 < self.attempts:
                self.next_request = max(self.next_request, monotonic() + delay * 2**attempt)
        if category == "rate-limited":
            raise RateLimited(category)
        raise DataError(category)


def completed_session(now, calendar):
    local_day = now.tz_convert(ZONE).tz_localize(None).normalize()
    expected = calendar.date_to_session(local_day, direction="previous")
    if calendar.session_close(expected) > now:
        expected = calendar.previous_session(expected)
    return expected


def prepare(symbol, raw, adjusted, now, calendar, *, exchange=None, expected=None):
    if expected is None:
        expected = completed_session(now, calendar)
    raw = raw.loc[:expected]
    adjusted = adjusted.loc[:expected]
    if raw.empty or not raw.index.equals(adjusted.index):
        raise DataError("raw-adjusted-session-mismatch")
    observed = raw.index[-1]
    if not raw.index.equals(calendar.sessions_in_range(raw.index[0], observed).rename("Date")):
        raise DataError("missing-or-invalid-trading-session")
    if observed != expected:
        raise DataError(f"stale-observation {observed.date()} expected {expected.date()}")
    if not raw["Volume"].equals(adjusted["Volume"]):
        raise DataError("raw-adjusted-volume-mismatch")
    differences = raw.index[~np.isclose(raw["Close"], adjusted["Close"], rtol=1e-9, atol=1e-8)]
    sample = differences[-1] if len(differences) else None
    comparison = {"differentCloseRows": len(differences), "example": None}
    if sample is not None:
        comparison["example"] = {"date": sample.date().isoformat(),
                                 "rawClose": float(raw.at[sample, "Close"]),
                                 "adjustedClose": float(adjusted.at[sample, "Close"])}
    status = {
        "source": "Yahoo Finance via yfinance", "symbol": symbol, "currency": "USD",
        "exchange": exchange or SYMBOLS[symbol], "observedAt": calendar.session_close(observed).isoformat(),
        "tradingDate": observed.date().isoformat(), "collectedAt": now.isoformat(),
        "isDelayed": None, "timing": "end-of-day", "dataStatus": "available",
        "nextSessionClose": calendar.session_close(calendar.next_session(observed)).isoformat(),
        "distribution": "local-research-only", "rows": len(raw), "comparison": comparison,
        "raw": {
            "adjustmentType": "yahoo-raw", "close": float(raw["Close"].iloc[-1]),
            "previousClose": float(raw["Close"].iloc[-2]) if len(raw) > 1 else None,
            "volume": int(raw["Volume"].iloc[-1]), "indicators": calculate(raw),
        },
        "adjusted": {
            "adjustmentType": "yahoo-auto-adjusted", "close": float(adjusted["Close"].iloc[-1]),
            "indicators": calculate(adjusted),
        },
    }
    return raw, adjusted, status


def publish(root, symbol, raw, adjusted, status):
    """Publish a complete pair through one atomic pointer change."""
    snapshots = root / "snapshots"
    snapshots.mkdir(parents=True, exist_ok=True)
    current = snapshots / symbol
    if current.is_symlink():
        previous = json.loads((current / "summary.json").read_text())
        if previous["tradingDate"] > status["tradingDate"]:
            raise DataError("would-replace-newer-observation")
    generation = Path(tempfile.mkdtemp(prefix=f".{symbol}-", dir=snapshots))
    aliases = []
    pointer = snapshots / f".publish-{uuid4().hex}"
    published = False
    try:
        raw.to_csv(generation / "raw.csv")
        adjusted.to_csv(generation / "adjusted.csv")
        (generation / "summary.json").write_text(json.dumps(status, allow_nan=False) + "\n")
        for folder, filename in (("data_raw", "raw.csv"), ("data_adj", "adjusted.csv")):
            alias = root / folder / f"{symbol}_1d.csv"
            alias.parent.mkdir(parents=True, exist_ok=True)
            target = Path("..") / "snapshots" / symbol / filename
            if alias.is_symlink() and alias.readlink() == target:
                continue
            link = alias.with_name(f".{alias.name}-{uuid4().hex}")
            link.symlink_to(target)
            aliases.append((link, alias))
        pointer.symlink_to(generation.name, target_is_directory=True)
        pointer.replace(current)
        published = True
        for link, alias in aliases:
            link.replace(alias)
    finally:
        pointer.unlink(missing_ok=True)
        for link, _ in aliases:
            link.unlink(missing_ok=True)
        if not published:
            rmtree(generation)


def collect(symbols, output):
    downloader = Downloader()
    calendar = xcals.get_calendar("XNYS")
    failed = False
    for symbol in dict.fromkeys(symbols):
        try:
            raw = downloader.history(symbol, False)
            adjusted = downloader.history(symbol, True)
            raw, adjusted, status = prepare(symbol, raw, adjusted, pd.Timestamp(datetime.now(timezone.utc)), calendar)
            publish(output, symbol, raw, adjusted, status)
            logging.info("%s %s rows=%s rawClose=%.6f adjustedClose=%.6f", symbol, status["tradingDate"],
                         len(raw), status["raw"]["close"], status["adjusted"]["close"])
            comparison = status["comparison"]
            if comparison["example"]:
                example = comparison["example"]
                logging.info("%s historical comparison %s rawClose=%.6f adjustedClose=%.6f differingRows=%s",
                             symbol, example["date"], example["rawClose"], example["adjustedClose"],
                             comparison["differentCloseRows"])
        except RateLimited:
            logging.error("%s failed: rate-limited; collection stopped", symbol)
            return 1
        except (DataError, OSError) as error:
            logging.error("%s failed: %s", symbol, error)
            failed = True
        except Exception as error:
            logging.error("%s failed: %s", symbol, type(error).__name__)
            failed = True
    return int(failed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("symbols", nargs="*", default=DEFAULT_SYMBOLS)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    invalid = set(args.symbols) - SYMBOLS.keys()
    if invalid:
        parser.error("unsupported symbols: " + ", ".join(sorted(invalid)))
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args.output.mkdir(parents=True, exist_ok=True)
    lock = args.output / ".collect.lock"
    with lock.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            logging.error("another collection is already active for this output directory")
            return 1
        return collect(args.symbols or DEFAULT_SYMBOLS, args.output)


if __name__ == "__main__":
    raise SystemExit(main())
