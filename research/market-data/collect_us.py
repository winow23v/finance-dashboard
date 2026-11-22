"""Collect member-market snapshots into a separate, server-owned cache."""

import argparse
import fcntl
import json
import logging
import os
from pathlib import Path
import re
import tempfile

import exchange_calendars as xcals
import pandas as pd

from collect import DataError, Downloader, RateLimited, completed_session, normalize, prepare

INDICES = ("^GSPC", "^IXIC", "^DJI")
STOCKS = ("AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "DELL", "V", "BRK-B", "VOO", "SCHD")
TICKER = re.compile(r"[A-Z][A-Z0-9]{0,9}(?:-[A-Z0-9]{1,5})?")


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def publish(path, value):
    path.parent.mkdir(exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
        temp = Path(handle.name)
        try:
            json.dump(value, handle, allow_nan=False)
            handle.flush()
            os.fchmod(handle.fileno(), 0o640)
            os.fsync(handle.fileno())
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


def bars(frame):
    return [
        dict(tradingDate=date.date().isoformat(), open=float(open_), high=float(high),
             low=float(low), close=float(close), volume=int(volume))
        for date, open_, high, low, close, volume in frame.itertuples()
    ]


def collect(root, symbols, downloader, calendar, now):
    session = completed_session(now - pd.Timedelta(minutes=20), calendar)
    target = session.date().isoformat()
    failed = False
    for symbol in dict.fromkeys(symbols):
        index = symbol in INDICES
        path = root / ("indices" if index else "stocks") / f"{symbol}.json"
        old = read_json(path)
        snapshot = old.get("snapshot")
        if snapshot and snapshot["tradingDate"] >= target:
            continue
        attempt = old.get("attempt", {})
        count = attempt.get("count", 0) if attempt.get("target") == target else 0
        if count >= 3:
            continue
        reason = None
        try:
            raw = downloader.history(symbol, False)
            adjusted = raw if index else downloader.history(symbol, True)
            if not index:
                metadata = downloader.ticker.history_metadata
                if metadata.get("currency") != "USD" or metadata.get("exchangeTimezoneName") != "America/New_York" or metadata.get("instrumentType") not in ("EQUITY", "ETF"):
                    raise DataError("unsupported-listing")
            raw, adjusted, summary = prepare(symbol, raw, adjusted, now, calendar, exchange="INDEX" if index else "US", expected=session)
            snapshot = {key: summary[key] for key in ("tradingDate", "collectedAt", "observedAt", "nextSessionClose")}
            snapshot.update(raw=bars(raw), adjusted=None if index else bars(adjusted))
            logging.info("%s %s %s bars", symbol, snapshot["tradingDate"], len(raw))
        except RateLimited:
            reason = "rate-limited"
        except DataError as error:
            detail = str(error)
            if detail == "unsupported-listing":
                reason = "unsupported"
            elif detail == "empty-response" or detail.startswith("stale-observation"):
                reason = "not-published"
            else:
                reason = "provider-error"
        except Exception:
            reason = "provider-error"
        if reason:
            failed = True
            logging.warning("%s %s %s", symbol, target, reason)
        publish(path, {"version": 1, "symbol": symbol, "snapshot": snapshot,
                       "attempt": {"target": target, "reason": reason, "count": count + 1}})
        if reason == "rate-limited":
            break
    return int(failed)


def check_cache(root, symbols, calendar, now):
    expected = completed_session(now - pd.Timedelta(minutes=20), calendar)
    failed = False
    for symbol in symbols:
        index = symbol in INDICES
        path = root / ("indices" if index else "stocks") / f"{symbol}.json"
        try:
            record = read_json(path)
            snapshot = record["snapshot"]
            if (record["version"] != 1 or record["symbol"] != symbol
                    or snapshot["tradingDate"] != expected.date().isoformat()):
                raise DataError("unexpected-session")
            collected = pd.Timestamp(snapshot["collectedAt"])
            observed = pd.Timestamp(snapshot["observedAt"])
            next_close = pd.Timestamp(snapshot["nextSessionClose"])
            if (observed != calendar.session_close(expected) or not observed <= collected <= now
                    or next_close != calendar.session_close(calendar.next_session(expected))):
                raise DataError("invalid-timestamps")

            def frame(rows):
                data = pd.DataFrame(rows).set_index("tradingDate")
                data.index = pd.to_datetime(data.index, format="%Y-%m-%d")
                normalized = normalize(data.rename(columns=str.capitalize), symbol)
                if not normalized.index.equals(data.index) or len(normalized) != len(rows):
                    raise DataError("invalid-cached-series")
                return normalized

            raw = frame(snapshot["raw"])
            adjusted = raw if index else frame(snapshot["adjusted"])
            prepare(symbol, raw, adjusted, collected, calendar,
                    exchange="INDEX" if index else "US", expected=expected)
            if len(raw) < 260:
                raise DataError("insufficient-history")
            logging.info("%s %s %s verified bars", symbol, snapshot["tradingDate"], len(raw))
        except (DataError, KeyError, TypeError, ValueError, OSError):
            logging.warning("%s cache-validation-failed", symbol)
            failed = True
    return int(failed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--queue", type=Path)
    parser.add_argument("--check", action="store_true", help="Verify initial cached symbols without fetching or writing")
    parser.add_argument("symbols", nargs="*")
    args = parser.parse_args()
    if any(symbol not in INDICES and not TICKER.fullmatch(symbol) for symbol in args.symbols):
        parser.error("invalid US ticker")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logging.getLogger("yfinance").setLevel(logging.CRITICAL)
    calendar = xcals.get_calendar("XNYS")
    if args.check:
        return check_cache(args.cache, args.symbols or (*INDICES, *STOCKS),
                           calendar, pd.Timestamp.now(tz="UTC"))
    args.cache.mkdir(parents=True, exist_ok=True)
    with (args.cache / ".collect.lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        now = pd.Timestamp.now(tz="UTC")
        queued = []
        if args.queue:
            for path in sorted(args.queue.iterdir()):
                if not TICKER.fullmatch(path.name) or not path.is_file() or path.is_symlink():
                    continue
                if now.timestamp() - path.stat().st_mtime >= 30 * 86400:
                    path.unlink(missing_ok=True)
                else:
                    queued.append(path.name)
        return collect(args.cache, args.symbols or (*INDICES, *STOCKS, *queued[:32]),
                       Downloader(attempts=1), calendar, now)


if __name__ == "__main__":
    raise SystemExit(main())
