"""Collect validated US market snapshots in a dedicated member cache."""

import argparse
import fcntl
import json
import logging
import math
import os
from pathlib import Path
import re
import tempfile
from time import monotonic, sleep

import exchange_calendars as xcals
import numpy as np
import pandas as pd

from collect import DataError, Downloader, PRICE_COLUMNS, RateLimited, completed_session, normalize, prepare

INDICES = ("^GSPC", "^IXIC", "^DJI")
STOCKS = ("AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "DELL", "V", "BRK-B", "VOO", "SCHD")
TICKER = re.compile(r"[A-Z][A-Z0-9]{0,9}(?:-[A-Z0-9]{1,5})?")
DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
SOURCE = "Yahoo Finance via yfinance"
ATTEMPT_LIMIT = 3
LOOKBACK = 10
MAX_SNAPSHOT_BARS = 550  # Existing member API cache contract.


def read_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
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


def iso(date):
    return date.date().isoformat()


def path_for(root, symbol):
    return root / ("indices" if symbol in INDICES else "stocks") / f"{symbol}.json"


def cache_frame(rows, symbol):
    if not isinstance(rows, list) or not rows:
        raise DataError("invalid-cached-series")
    data = pd.DataFrame(rows).set_index("tradingDate")
    if not all(isinstance(value, str) and DAY.fullmatch(value) for value in data.index):
        raise DataError("invalid-session-date")
    data.index = pd.to_datetime(data.index, format="%Y-%m-%d")
    normalized = normalize(data.rename(columns=str.capitalize), symbol)
    if not normalized.index.equals(data.index):
        raise DataError("invalid-cached-series")
    return normalized


def snapshot_pair(record, symbol, calendar, now):
    if not record:
        return None
    snapshot = record["snapshot"]
    if record.get("version") != 1 or record.get("symbol") != symbol:
        raise DataError("invalid-cache-record")
    if snapshot is None:
        return None
    raw = cache_frame(snapshot["raw"], symbol)
    adjusted = raw if symbol in INDICES else cache_frame(snapshot["adjusted"], symbol)
    for frame in (raw, adjusted):
        if not all(calendar.is_session(date) for date in frame.index):
            raise DataError("missing-or-invalid-trading-session")
    latest = raw.index[-1]
    if (iso(latest) != snapshot["tradingDate"] or pd.Timestamp(snapshot["observedAt"]) != calendar.session_close(latest)
            or not calendar.session_close(latest) <= pd.Timestamp(snapshot["collectedAt"]) <= now
            or pd.Timestamp(snapshot["nextSessionClose"]) != calendar.session_close(calendar.next_session(latest))):
        raise DataError("invalid-timestamps")
    overlap = raw.index.intersection(adjusted.index)
    if not raw.loc[overlap, "Volume"].equals(adjusted.loc[overlap, "Volume"]):
        raise DataError("raw-adjusted-volume-mismatch")
    return raw, adjusted


def missing(pair, dates):
    if pair is None:
        return []
    raw, adjusted = pair
    # Both series must have established coverage before a gap is actionable.
    start = max(raw.index[0], adjusted.index[0])
    return [date for date in dates if date >= start and (date not in raw.index or date not in adjusted.index)]


def category(error):
    if isinstance(error, RateLimited):
        return "rate-limited", "rate-limited"
    if not isinstance(error, DataError):
        return "provider-error", type(error).__name__
    detail = str(error)
    code = detail.split()[0]
    if code == "stale-observation" and re.fullmatch(r"stale-observation \d{4}-\d{2}-\d{2} expected \d{4}-\d{2}-\d{2}", detail):
        return code, detail
    if code in ("empty-response", "no-usable-bars"):
        return "empty-response", code
    if code.startswith("raw-adjusted-"):
        return "raw-adjusted-mismatch", code
    if code in ("unsupported-listing", "connection-failure", "missing-or-invalid-trading-session",
                "snapshot-capacity-exceeded", "insufficient-history"):
        return (code if code == "unsupported-listing" else "provider-error"), code
    if code in {"duplicate-session-date", "invalid-session-date", "invalid-ohlcv-columns",
                "ambiguous-symbol-columns", "missing-close", "missing-volume", "invalid-price-or-volume",
                "invalid-volume", "inconsistent-ohlc", "invalid-cached-series"}:
        return "invalid-ohlcv", code
    return "provider-error", "data-validation-failed"


def metadata(symbol, target, now, count, latest, status, reason=None, detail=None, retry=None):
    return dict(symbol=symbol, target=target, status=status, reason=reason, detail=detail,
                attemptCount=count, attemptedAt=now.isoformat(), lastSuccessfulDate=latest,
                nextRetryAt=retry.isoformat() if retry is not None else None, source=SOURCE)


def download(downloader, request, symbol, target, calendar, window):
    raw = normalize(request(symbol, False, **window), symbol)
    adjusted = raw
    if symbol not in INDICES:
        adjusted = normalize(request(symbol, True, **window), symbol)
        listing = downloader.ticker.history_metadata
        if (listing.get("currency") != "USD" or listing.get("exchangeTimezoneName") != "America/New_York"
                or listing.get("instrumentType") not in ("EQUITY", "ETF")):
            raise DataError("unsupported-listing")
    raw, adjusted = raw.loc[:target], adjusted.loc[:target]
    if raw.empty:
        raise DataError("empty-response")
    if not raw.index.equals(adjusted.index):
        raise DataError("raw-adjusted-session-mismatch")
    if not raw["Volume"].equals(adjusted["Volume"]):
        raise DataError("raw-adjusted-volume-mismatch")
    if not all(calendar.is_session(date) for date in raw.index):
        raise DataError("missing-or-invalid-trading-session")
    return raw, adjusted


def merge(pair, fresh, selected):
    if pair is None:
        return fresh
    raw, adjusted = pair
    new_raw, new_adjusted = fresh
    if not len(selected):
        return pair
    # Keep the stored adjusted price scale across a provider-wide rebase.
    overlap = raw.index.intersection(adjusted.index).intersection(new_raw.index)
    if len(overlap):
        old_factor = adjusted.loc[overlap, PRICE_COLUMNS].to_numpy() / raw.loc[overlap, PRICE_COLUMNS].to_numpy()
        new_factor = new_adjusted.loc[overlap, PRICE_COLUMNS].to_numpy() / new_raw.loc[overlap, PRICE_COLUMNS].to_numpy()
        scale = old_factor / new_factor
        if not np.allclose(scale, scale[-1, -1], rtol=1e-4, atol=1e-8):
            raise DataError("raw-adjusted-basis-mismatch")
        if not np.isclose(scale[-1, -1], 1, rtol=1e-6):
            new_adjusted = new_adjusted.copy()
            new_adjusted[PRICE_COLUMNS] *= scale[-1, -1]
    elif len(selected):
        raise DataError("raw-adjusted-no-overlap")
    return tuple(pd.concat([old, new.loc[new.index.intersection(selected).difference(old.index)]])
                 .sort_index() for old, new in zip(pair, fresh))


def build_snapshot(symbol, pair, now, calendar, expected, previous=None, *, rolling=False):
    raw, adjusted, summary = prepare(symbol, *pair, now, calendar,
                                     exchange="INDEX" if symbol in INDICES else "US", expected=expected)
    if len(raw) < 260:
        raise DataError("insufficient-history")
    if len(raw) > MAX_SNAPSHOT_BARS:
        if not rolling:
            raise DataError("snapshot-capacity-exceeded")
        raw, adjusted = raw.iloc[-MAX_SNAPSHOT_BARS:], adjusted.iloc[-MAX_SNAPSHOT_BARS:]
    snapshot = {key: summary[key] for key in ("tradingDate", "collectedAt", "observedAt", "nextSessionClose")}
    if previous and previous["tradingDate"] == snapshot["tradingDate"]:
        snapshot["collectedAt"] = previous["collectedAt"]
    snapshot.update(raw=bars(raw), adjusted=None if symbol in INDICES else bars(adjusted))
    return snapshot


def plan(root, symbols, calendar, now, dates=None):
    try:
        recovery = read_json(root / ".collection-state.json").get("recovery", {})
    except (ValueError, OSError):
        recovery = {}
    target = completed_session(now - pd.Timedelta(minutes=20), calendar)
    eligible = calendar.sessions_in_range(target - pd.Timedelta(days=31), target)[-LOOKBACK:]
    if dates is not None:
        eligible = eligible.intersection(dates)
    result = []
    for symbol in symbols:
        try:
            record = read_json(path_for(root, symbol))
            pair = snapshot_pair(record, symbol, calendar, now)
            gaps = missing(pair, eligible)
            reason = record.get("collection", {}).get("reason")
            if (reason == "unsupported-listing" or record.get("attempt", {}).get("reason") == "unsupported"
                    or any(entry.get("reason") == "unsupported-listing"
                           for entry in recovery.get(symbol, {}).values())):
                status, gaps = "unsupported-listing", []
            elif pair is None:
                status = "unverified-listing"
            else:
                status = "missing" if gaps else "available"
            result.append(dict(symbol=symbol, status=status, dates=[iso(date) for date in gaps],
                               maxRequests=(1 if symbol in INDICES else 2) if gaps else 0))
        except (DataError, KeyError, TypeError, ValueError, OSError) as error:
            result.append(dict(symbol=symbol, status="invalid-cache", dates=[], maxRequests=0,
                               detail=category(error)[1]))
    return target, result


def collect(root, symbols, downloader, calendar, now, *, apply_only=False, dates=None,
            max_requests=40, minimum_interval=2.0):
    target = completed_session(now - pd.Timedelta(minutes=20), calendar)
    journal_path = root / ".collection-state.json"
    journal = read_json(journal_path)
    if not isinstance(journal, dict):
        raise DataError("invalid-collection-journal")
    requests = 0
    partial = False
    halted = False
    counts = dict(success=0, pending=0, failed=0, rateLimited=0, recovered=0)
    today = now.tz_convert("America/New_York").date().isoformat()
    market_closed = not calendar.is_session(today)
    cooldown = pd.Timestamp(journal["cooldownUntil"]) if journal.get("cooldownUntil") else None
    if cooldown is not None and now < cooldown:
        counts["rateLimited"] = 1
        halted = True
    sessions = calendar.sessions_in_range(target - pd.Timedelta(days=31), target)[-LOOKBACK:]
    eligible = sessions.intersection(dates) if dates is not None else sessions
    active = {iso(date) for date in sessions}
    journal["lastBySymbol"] = {symbol: at for symbol, at in journal.get("lastBySymbol", {}).items()
                               if pd.Timestamp(at) >= now - pd.Timedelta(days=30)}
    journal["recovery"] = {symbol: {day: attempt for day, attempt in attempts.items() if day in active}
                           for symbol, attempts in journal.get("recovery", {}).items()
                           if any(day in active for day in attempts)}
    started = monotonic()

    def request(symbol, adjusted, **window):
        nonlocal requests
        dispatch = now + pd.Timedelta(seconds=monotonic() - started)
        previous = journal.get("lastRequestAt")
        if previous:
            sleep(max(0, minimum_interval - (dispatch - pd.Timestamp(previous)).total_seconds()))
            dispatch = now + pd.Timedelta(seconds=monotonic() - started)
        journal["lastRequestAt"] = dispatch.isoformat()
        journal.setdefault("lastBySymbol", {})[symbol] = dispatch.isoformat()
        publish(journal_path, journal)
        requests += 1
        try:
            return downloader.history(symbol, adjusted, **window)
        except OSError:
            raise DataError("connection-failure") from None

    profiles = {}
    regular_dispatched = set()

    for symbol in symbols:
        path = path_for(root, symbol)
        try:
            record = read_json(path)
            pair = snapshot_pair(record, symbol, calendar, now)
            profiles[symbol] = [record, pair]
        except (DataError, KeyError, TypeError, ValueError, OSError) as error:
            counts["failed"] += 1
            logging.error("%s %s invalid-cache %s", symbol, iso(target), category(error)[1])

    def run(symbol, phase, selected):
        nonlocal requests, halted, partial
        record, pair = profiles[symbol]
        path = path_for(root, symbol)
        visible = record.get("snapshot")
        latest = visible["tradingDate"] if visible else None
        needed = 1 if symbol in INDICES else 2
        if halted or requests + needed > max_requests:
            partial = True
            return
        if phase == "regular":
            prior = record.get("attempt", {})
            keys = [iso(target)]
            if prior.get("target") != keys[0]:
                prior = {}
            attempts = {keys[0]: prior}
        else:
            attempts = journal["recovery"].setdefault(symbol, {})
            keys = [iso(date) for date in selected]
        due = []
        for key in keys:
            previous = attempts.get(key, {})
            count = previous.get("attemptCount", previous.get("count", 0))
            retry = previous.get("nextRetryAt")
            if count < ATTEMPT_LIMIT and (not retry or now >= pd.Timestamp(retry)):
                due.append(key)
        if not due:
            partial = True
            return
        selected = pd.DatetimeIndex(due)
        if phase == "regular":
            regular_dispatched.add(symbol)
        counts_by_target = {key: attempts.get(key, {}).get("attemptCount", attempts.get(key, {}).get("count", 0)) + 1
                            for key in due}

        def update(status, reason=None, detail=None):
            for key, count in counts_by_target.items():
                delay = (120 if reason == "provider-error" else 60) * 2 ** (count - 1)
                retry = (now + pd.Timedelta(minutes=delay) if count < ATTEMPT_LIMIT
                         and reason != "unsupported-listing" and status != "success" else None)
                attempts[key] = metadata(symbol, key, now, count, latest, status, reason, detail, retry)

        def write_record():
            record.update(version=1, symbol=symbol, snapshot=visible)
            publish(path, record)

        update("retry-pending")
        publish(journal_path, journal)
        if phase == "regular":
            record["attempt"] = dict(attempts[due[0]], count=counts_by_target[due[0]])
            write_record()
        try:
            window = {}
            if phase == "recovery":
                start = calendar.previous_session(selected.min())
                window = dict(start=iso(start), end=iso(calendar.next_session(selected.max()) + pd.Timedelta(days=1)))
            fresh = download(downloader, request, symbol, target, calendar, window)
            if not selected.isin(fresh[0].index).all():
                observed = fresh[0].index[-1]
                if observed < selected.max():
                    raise DataError(f"stale-observation {iso(observed)} expected {iso(selected.max())}")
                raise DataError("missing-or-invalid-trading-session")
            additions = selected
            if phase == "regular" and pair is not None:
                eligible_fresh = fresh[0].index.intersection(sessions)
                additions = pd.DatetimeIndex(missing(pair, eligible_fresh))
            merged = merge(pair, fresh, additions)
            latest_date = merged[0].index[-1]
            visible = build_snapshot(symbol, merged, now, calendar, latest_date, visible,
                                     rolling=phase == "regular")
            if phase == "regular":
                merged = tuple(frame.iloc[-MAX_SNAPSHOT_BARS:] for frame in merged)
        except OSError:
            raise
        except DataError as error:
            reason, detail = category(error)
        except Exception as error:
            reason, detail = category(error)
        else:
            reason = detail = None
            latest = visible["tradingDate"]

        update("pending" if reason else "success", reason, detail)
        outcome = attempts[due[-1]]
        if phase == "regular":
            legacy = {"empty-response": "not-published", "stale-observation": "not-published",
                      "unsupported-listing": "unsupported", "rate-limited": "rate-limited"}
            record["attempt"] = dict(outcome, count=outcome["attemptCount"],
                                     reason=legacy.get(reason, "provider-error") if reason else None)
        if phase == "recovery" and not reason and record.get("attempt", {}).get("target") == latest:
            record["attempt"] = {**record["attempt"], "reason": None}
        if phase == "regular" or not reason:
            record["collection" if phase == "regular" else "recovery"] = outcome
        if reason:
            partial = True
        if reason == "rate-limited":
            counts["rateLimited"] += 1
            journal["cooldownUntil"] = (now + pd.Timedelta(hours=1)).isoformat()
            halted = True
        publish(journal_path, journal)
        if phase == "regular" or not reason:
            write_record()
        if not reason:
            profiles[symbol][1] = merged
            counts["recovered"] += len(additions) if phase == "recovery" else sum(date < target for date in additions)
        logging.info("US_COLLECTION_RESULT %s", json.dumps(outcome))

    try:
        if not apply_only:
            for symbol, (record, pair) in profiles.items():
                if ((pair is None or pair[0].index[-1] < target)
                        and record.get("attempt", {}).get("reason") != "unsupported"):
                    run(symbol, "regular", [])
        for symbol, (record, pair) in profiles.items():
            # Let regular slots own the latest date. Manual recovery may target it.
            candidates = eligible if apply_only else eligible[eligible < target]
            if (symbol in regular_dispatched or record.get("attempt", {}).get("reason") == "unsupported"
                    or any(entry.get("reason") == "unsupported-listing"
                           for entry in journal["recovery"].get(symbol, {}).values())):
                continue
            gaps = missing(pair, candidates)
            if gaps:
                run(symbol, "recovery", gaps)
    except OSError:
        counts["failed"] += 1
        logging.error("US_COLLECTION_STORAGE_FAILED")

    for record, pair in profiles.values():
        required = eligible if apply_only else sessions
        if pair is not None and (apply_only or pair[0].index[-1] == target) and not missing(pair, required):
            counts["success"] += 1
        else:
            counts["pending"] += 1
    state = ("failed" if counts["failed"] else "rate-limited" if counts["rateLimited"] else
             "partial-success" if counts["success"] and (partial or counts["pending"]) else
             "failed" if counts["pending"] else "market-closed" if market_closed and not requests else "success")
    print("US_COLLECTION_SUMMARY", json.dumps(dict(targetDate=iso(target), status=state, requests=requests, **counts)))
    return {"failed": 1, "rate-limited": 75}.get(state, 0)


def check_cache(root, symbols, calendar, now):
    expected = completed_session(now - pd.Timedelta(minutes=20), calendar)
    failed = False
    for symbol in symbols:
        try:
            record = read_json(path_for(root, symbol))
            pair = snapshot_pair(record, symbol, calendar, now)
            if pair is None or pair[0].index[-1] != expected:
                raise DataError("unexpected-session")
            build_snapshot(symbol, pair, now, calendar, expected)
            logging.info("%s %s %s verified bars", symbol, iso(expected), len(pair[0]))
        except (DataError, KeyError, TypeError, ValueError, OSError):
            logging.warning("%s cache-validation-failed", symbol)
            failed = True
    return int(failed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--queue", type=Path)
    modes = parser.add_mutually_exclusive_group()
    for mode in ("check", "plan", "apply"):
        modes.add_argument(f"--{mode}", action="store_true")
    parser.add_argument("--symbols", dest="selected")
    parser.add_argument("--dates")
    parser.add_argument("--max-requests", type=int, default=40)
    parser.add_argument("--minimum-interval", type=float, default=2.0)
    parser.add_argument("symbols", nargs="*")
    args = parser.parse_args()
    symbols = args.selected.split(",") if args.selected is not None else args.symbols
    if (args.selected is not None and args.symbols) or any(symbol not in INDICES and not TICKER.fullmatch(symbol) for symbol in symbols):
        parser.error("invalid US ticker selection")
    if not 1 <= args.max_requests <= 100 or not math.isfinite(args.minimum_interval) or args.minimum_interval < 2:
        parser.error("invalid request policy")
    dates = None
    if args.dates is not None:
        try:
            values = args.dates.split(",")
            if not (args.plan or args.apply) or len(values) > LOOKBACK or not all(DAY.fullmatch(date) for date in values):
                raise ValueError()
            dates = pd.DatetimeIndex(pd.to_datetime(values, format="%Y-%m-%d"))
        except ValueError:
            parser.error("--dates requires --plan or --apply with YYYY-MM-DD values")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logging.getLogger("yfinance").setLevel(logging.CRITICAL)
    calendar = xcals.get_calendar("XNYS")
    now = pd.Timestamp.now(tz="UTC")
    queued = []
    if args.queue:
        for path in sorted(args.queue.iterdir()):
            if not TICKER.fullmatch(path.name) or path.is_symlink() or not path.is_file():
                continue
            if now.timestamp() - path.stat().st_mtime < 30 * 86400:
                queued.append(path.name)
    symbols = list(dict.fromkeys(symbols or (*INDICES, *STOCKS, *queued[:32])))
    if args.check:
        return check_cache(args.cache, symbols, calendar, now)
    if args.plan:
        target, targets = plan(args.cache, symbols, calendar, now, dates)
        outside = [iso(date) for date in dates if date > target or not calendar.is_session(date)
                   or calendar.sessions_distance(date, target) > LOOKBACK] if dates is not None else []
        print(json.dumps(dict(targetDate=iso(target), targets=targets, deferredDates=outside,
                              maxRequests=min(args.max_requests, sum(item["maxRequests"] for item in targets)),
                              attempts=0)))
        return int(any(item["status"] == "invalid-cache" for item in targets))
    try:
        args.cache.mkdir(parents=True, exist_ok=True)
        with (args.cache / ".collect.lock").open("a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                logging.info("US_COLLECTION_BUSY")
                return 0
            return collect(args.cache, symbols, Downloader(attempts=1, minimum_interval=args.minimum_interval),
                           calendar, now, apply_only=args.apply, dates=dates,
                           max_requests=args.max_requests, minimum_interval=args.minimum_interval)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        logging.error("US_COLLECTION_FAILED cache or journal unavailable")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
