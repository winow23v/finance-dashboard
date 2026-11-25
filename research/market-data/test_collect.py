import json

import exchange_calendars as xcals
import numpy as np
import pandas as pd
import pytest

from collect import DataError, EmptyData, completed_session, normalize, prepare, publish
from indicators import calculate

CALENDAR = xcals.get_calendar("XNYS")
NOW = pd.Timestamp("2026-10-12T22:00:00Z")


def bars(length=300):
    days = CALENDAR.sessions_in_range("2025-01-02", "2026-10-12")[-length:]
    close = np.arange(len(days), dtype=float) + 100
    return pd.DataFrame({"Open": close, "High": close + 1, "Low": close - 1,
                         "Close": close, "Volume": 3000}, index=days)


@pytest.mark.parametrize("ticker_first", [False, True])
def test_normalizes_multi_index_sorts_and_drops_trailing_missing_close(ticker_first):
    frame = bars(6)
    frame.loc[frame.index[-1], "Close"] = np.nan
    frame.columns = pd.MultiIndex.from_tuples([(field, "KO") for field in frame.columns])
    if ticker_first:
        frame.columns = frame.columns.swaplevel()
    result = normalize(frame.iloc[::-1], "KO")
    assert result.index.is_monotonic_increasing
    assert len(result) == 5


@pytest.mark.parametrize("field,value,reason", [
    ("Close", np.nan, "missing-close"), ("Volume", np.nan, "missing-volume"),
    ("Low", -1, "invalid-price-or-volume"), ("High", 1, "inconsistent-ohlc"),
])
def test_invalid_observations_are_rejected(field, value, reason):
    frame = bars(6)
    frame.loc[frame.index[1], field] = value
    with pytest.raises(DataError, match=reason):
        normalize(frame, "KO")


def test_empty_and_duplicate_dates_are_rejected():
    with pytest.raises(EmptyData):
        normalize(pd.DataFrame(), "KO")
    frame = bars(6)
    with pytest.raises(DataError, match="duplicate"):
        normalize(pd.concat([frame, frame.iloc[:1]]), "KO")


def test_calendar_uses_completed_session_and_half_days():
    early_close = pd.Timestamp("2026-11-27T19:00:00Z")
    assert completed_session(early_close, CALENDAR) == pd.Timestamp("2026-11-27")
    assert completed_session(early_close - pd.Timedelta(hours=2), CALENDAR) == pd.Timestamp("2026-11-25")


def test_pairs_shares_last_observation_and_rejects_stale_or_missing_sessions():
    raw = normalize(bars(), "KO")
    adjusted = raw.copy()
    adjusted.loc[:, ["Open", "High", "Low", "Close"]] *= 0.90
    _, _, summary = prepare("KO", raw, adjusted, NOW, CALENDAR)
    assert summary["raw"]["close"] != summary["adjusted"]["close"]
    assert summary["raw"]["indicators"]["rsi14"] == 100
    with pytest.raises(DataError, match="raw-adjusted-session-mismatch"):
        prepare("KO", raw, adjusted.iloc[:-1], NOW, CALENDAR)
    with pytest.raises(DataError, match="stale-observation"):
        prepare("KO", raw.iloc[:-1], adjusted.iloc[:-1], NOW, CALENDAR)
    with pytest.raises(DataError, match="missing-or-invalid"):
        prepare("KO", raw.drop(raw.index[3]), adjusted.drop(adjusted.index[3]), NOW, CALENDAR)


def test_warmup_and_indicators():
    result = calculate(bars(8))
    assert result["sma"]["20"] is None
    assert result["rsi14"] is None
    assert result["macd"]["signal"] is None
    assert result["returns"]["6M"] is None
    result = calculate(bars(300))
    assert result["sma"]["20"] == pytest.approx(389.5)
    assert result["ema"]["20"] == pytest.approx(389.5)
    assert result["macd"]["line"] == pytest.approx(7)
    assert result["macd"]["signal"] == pytest.approx(7)
    assert result["volumeSma20"] == 3000
    assert result["changeRate"] == pytest.approx(399 / 398 - 1)


def test_publish_pairs_preserves_prior_files_if_new_generation_fails(tmp_path, monkeypatch):
    raw, adjusted, summary = prepare("KO", normalize(bars(), "KO"), normalize(bars(), "KO"), NOW, CALENDAR)
    publish(tmp_path, "KO", raw, adjusted, summary)
    pointer = tmp_path / "snapshots" / "KO"
    before = pointer.resolve()
    assert json.loads((pointer / "summary.json").read_text())["rows"] == len(raw)
    assert (tmp_path / "data_raw" / "KO_1d.csv").resolve() == before / "raw.csv"
    assert (tmp_path / "data_adj" / "KO_1d.csv").resolve() == before / "adjusted.csv"

    def incomplete(*args, **kwargs):
        raise OSError("write failed")

    monkeypatch.setattr(adjusted, "to_csv", incomplete)
    with pytest.raises(OSError):
        publish(tmp_path, "KO", raw, adjusted, summary)
    assert pointer.resolve() == before


def test_rate_limits_back_off_and_end_batch(monkeypatch):
    import collect

    calls = []
    time = [0.0]
    monkeypatch.setattr(collect, "monotonic", lambda: time[0])

    def sleep_for(duration):
        time[0] += duration

    class Ticker:
        def __init__(self, symbol):
            assert symbol == "KO"

        def history(self, **options):
            calls.append((time[0], options["auto_adjust"]))
            raise collect.YFRateLimitError()

    monkeypatch.setattr(collect, "sleep", sleep_for)
    monkeypatch.setattr(collect.yf, "Ticker", Ticker)
    with pytest.raises(collect.RateLimited):
        collect.Downloader().history("KO", True)
    assert calls == [(0.0, True), (15.0, True), (45.0, True)]


def test_connection_failure_retries_without_changing_mode(monkeypatch):
    import collect

    calls = []
    monkeypatch.setattr(collect, "sleep", lambda _: None)

    class Ticker:
        def __init__(self, _symbol):
            pass

        def history(self, **options):
            calls.append(options["auto_adjust"])
            if len(calls) == 1:
                raise TimeoutError
            return bars(10)

    monkeypatch.setattr(collect.yf, "Ticker", Ticker)
    assert len(collect.Downloader().history("KO", False)) == 10
    assert calls == [False, False]


@pytest.mark.parametrize("utc, date", [
    ("2026-07-06T20:30:00Z", "2026-07-06"),  # summer close at 20:00 UTC
    ("2026-11-30T20:30:00Z", "2026-11-27"),  # winter close at 21:00 UTC
    ("2026-11-28T22:00:00Z", "2026-11-27"),  # Saturday
    ("2026-11-26T22:00:00Z", "2026-11-25"),  # Thanksgiving
])
def test_us_completed_session_boundaries(utc, date):
    assert completed_session(pd.Timestamp(utc), CALENDAR) == pd.Timestamp(date)


def test_us_collector_persists_history_and_preserves_it_when_refresh_fails(tmp_path):
    from types import SimpleNamespace
    from collect import RateLimited
    from collect_us import check_cache, collect

    class FixtureDownloader:
        calls = 0
        offline = False
        ticker = SimpleNamespace(history_metadata={
            "currency": "USD", "exchangeTimezoneName": "America/New_York", "instrumentType": "EQUITY",
        })

        def history(self, symbol, adjusted):
            self.calls += 1
            if self.offline:
                raise RateLimited("rate-limited")
            frame = normalize(bars(), symbol)
            if adjusted:
                frame.loc[:, ["Open", "High", "Low", "Close"]] *= 0.9
            return frame

    downloader = FixtureDownloader()
    symbols = ("^GSPC", "ABCD")
    assert collect(tmp_path, symbols, downloader, CALENDAR, NOW) == 0
    assert downloader.calls == 3
    path = tmp_path / "stocks" / "ABCD.json"
    previous = json.loads(path.read_text())
    assert len(previous["snapshot"]["adjusted"]) == 300
    assert previous["snapshot"]["adjusted"][-1]["close"] != previous["snapshot"]["raw"][-1]["close"]
    assert check_cache(tmp_path, symbols, CALENDAR, NOW) == 0
    assert check_cache(tmp_path, ("MISSING",), CALENDAR, NOW) == 1
    assert collect(tmp_path, symbols, downloader, CALENDAR, NOW) == 0
    assert downloader.calls == 3
    downloader.offline = True
    assert collect(tmp_path, ("ABCD",), downloader, CALENDAR, NOW + pd.Timedelta(days=1)) == 75
    failed = json.loads(path.read_text())
    assert failed["snapshot"] == previous["snapshot"]
    assert failed["attempt"]["reason"] == "rate-limited"


US_NOW = pd.Timestamp("2026-11-24T01:00:00Z")
VISA = pd.Timestamp("2026-11-23")
PRIOR = pd.Timestamp("2026-11-20")


def us_series(last=VISA):
    dates = CALENDAR.sessions_in_range("2024-01-02", last)[-502:]
    value = np.arange(len(dates), dtype=float) + 100
    return normalize(pd.DataFrame(dict(Open=value, High=value + 1, Low=value - 1,
                                       Close=value, Volume=100), index=dates), "V")


def us_seed(root, symbol="V", end=PRIOR, gap=None, *, attempt_count=3):
    import collect_us as us

    frame = us_series().loc[:end]
    snapshot = us.build_snapshot(symbol, (frame, frame), US_NOW, CALENDAR, end)
    if gap:
        for key in ("raw", "adjusted"):
            if snapshot[key] is not None:
                snapshot[key] = [row for row in snapshot[key] if row["tradingDate"] != gap]
    record = dict(version=1, symbol=symbol, snapshot=snapshot,
                  attempt=dict(target="2026-11-23", count=attempt_count, reason="not-published"))
    us.publish(us.path_for(root, symbol), record)
    return record


class USDownloader:
    def __init__(self, frame=None, error=None, adjusted=None):
        from types import SimpleNamespace
        self.frame = us_series() if frame is None else frame
        self.adjusted = adjusted
        self.error = error
        self.calls = []
        self.ticker = SimpleNamespace(history_metadata=dict(
            currency="USD", exchangeTimezoneName="America/New_York", instrumentType="EQUITY"))

    def history(self, symbol, adjusted, **window):
        self.calls.append((symbol, adjusted, window))
        if self.error:
            raise self.error
        frame = self.adjusted if adjusted and self.adjusted is not None else self.frame
        if window and not frame.empty:
            return frame.loc[(frame.index >= window["start"]) & (frame.index < window["end"])]
        return frame


def test_visa_plan_apply_and_idempotence(tmp_path):
    import collect_us as us

    original = us_seed(tmp_path)
    path = us.path_for(tmp_path, "V")
    before = path.read_bytes()
    _, entries = us.plan(tmp_path, ["V"], CALENDAR, US_NOW, [VISA])
    assert entries == [dict(symbol="V", status="missing", dates=["2026-11-23"], maxRequests=2)]
    assert us.check_cache(tmp_path, ["V"], CALENDAR, US_NOW) == 1
    assert path.read_bytes() == before
    assert not (tmp_path / ".collection-state.json").exists()
    downloader = USDownloader()
    assert us.collect(tmp_path, ["V"], downloader, CALENDAR, US_NOW, apply_only=True,
                      dates=[VISA], minimum_interval=0) == 0
    repaired = us.read_json(path)
    assert repaired["snapshot"]["tradingDate"] == "2026-11-23"
    for key in ("raw", "adjusted"):
        assert len(original["snapshot"][key]) == 501
        assert repaired["snapshot"][key][:-1] == original["snapshot"][key]
        assert repaired["snapshot"][key][-1]["tradingDate"] == "2026-11-23"
    assert repaired["version"] == 1 and repaired["attempt"] == {**original["attempt"], "reason": None}
    assert us.check_cache(tmp_path, ["V"], CALENDAR, US_NOW) == 0
    after = path.read_bytes()
    assert us.collect(tmp_path, ["V"], downloader, CALENDAR, US_NOW, apply_only=True,
                      dates=[VISA], minimum_interval=0) == 0
    assert len(downloader.calls) == 2
    assert path.read_bytes() == after


@pytest.mark.parametrize("apply_only", [True, False], ids=["recovery", "regular"])
def test_adjusted_rebase_uses_stored_price_scale(tmp_path, apply_only):
    import collect_us as us

    original = us_seed(tmp_path, attempt_count=0)
    raw = us_series()
    adjusted = raw.copy()
    adjusted[us.PRICE_COLUMNS] *= 0.5
    downloader = USDownloader(raw, adjusted=adjusted)
    assert us.collect(tmp_path, ["V"], downloader, CALENDAR, US_NOW,
                      apply_only=apply_only, minimum_interval=0) == 0
    updated = us.read_json(us.path_for(tmp_path, "V"))["snapshot"]
    assert updated["adjusted"][:-1] == original["snapshot"]["adjusted"]
    assert updated["adjusted"][-1] == updated["raw"][-1]


@pytest.mark.parametrize("apply_only", [True, False], ids=["recovery", "regular"])
def test_raw_rebase_preserves_last_good_snapshot(tmp_path, apply_only):
    import collect_us as us

    original = us_seed(tmp_path, attempt_count=0)
    rebased = us_series()
    rebased[us.PRICE_COLUMNS] *= 0.5
    downloader = USDownloader(rebased)
    assert us.collect(tmp_path, ["V"], downloader, CALENDAR, US_NOW,
                      apply_only=apply_only, minimum_interval=0) == 1
    assert us.read_json(us.path_for(tmp_path, "V"))["snapshot"] == original["snapshot"]
    if apply_only:
        journal = us.read_json(tmp_path / ".collection-state.json")
        attempt = journal["recovery"]["V"]["2026-11-23"]
    else:
        attempt = us.read_json(us.path_for(tmp_path, "V"))["attempt"]
    assert attempt["detail"] == "raw-adjusted-basis-mismatch"


@pytest.mark.parametrize("kind", ["empty", "stale", "duplicate", "mismatch", "network", "rate"])
def test_failed_recovery_keeps_snapshot_and_records_specific_reason(tmp_path, kind):
    import collect_us as us

    us_seed(tmp_path)
    frame = us_series()
    if kind == "empty":
        downloader, expected = USDownloader(pd.DataFrame()), "empty-response"
    elif kind == "stale":
        downloader, expected = USDownloader(frame.iloc[:-1]), "stale-observation"
    elif kind == "duplicate":
        downloader, expected = USDownloader(pd.concat([frame, frame.iloc[-1:]])), "invalid-ohlcv"
    elif kind == "mismatch":
        downloader, expected = USDownloader(frame, adjusted=frame.iloc[:-1]), "raw-adjusted-mismatch"
    elif kind == "network":
        downloader, expected = USDownloader(error=ConnectionError("private payload")), "provider-error"
    else:
        downloader, expected = USDownloader(error=us.RateLimited("throttled")), "rate-limited"
    path = us.path_for(tmp_path, "V")
    before = path.read_bytes()
    status = us.collect(tmp_path, ["V"], downloader, CALENDAR, US_NOW, apply_only=True, minimum_interval=0)
    assert status == (75 if kind == "rate" else 1)
    assert path.read_bytes() == before
    state = us.read_json(tmp_path / ".collection-state.json")
    assert state["recovery"]["V"]["2026-11-23"]["reason"] == expected
    assert "private payload" not in json.dumps(state)


def test_automatic_repairs_old_interior_gap_without_refetching_healthy_assets(tmp_path, capsys):
    import collect_us as us

    us_seed(tmp_path, end=VISA, gap="2026-11-20")
    healthy = [symbol for symbol in (*us.INDICES, *us.STOCKS) if symbol != "V"]
    for symbol in healthy:
        us_seed(tmp_path, symbol, VISA)
    before = {symbol: us.path_for(tmp_path, symbol).read_bytes() for symbol in healthy}
    downloader = USDownloader()
    assert us.collect(tmp_path, [*healthy, "V"], downloader, CALENDAR, US_NOW, minimum_interval=0) == 0
    assert [call[0] for call in downloader.calls] == ["V", "V"]
    assert all(us.path_for(tmp_path, symbol).read_bytes() == value for symbol, value in before.items())
    assert us.check_cache(tmp_path, [*healthy, "V"], CALENDAR, US_NOW) == 0
    summary = json.loads(capsys.readouterr().out.splitlines()[-1].split(" ", 1)[1])
    assert summary["success"] == 13 and summary["recovered"] == 1


def test_cli_readonly_modes_and_shared_lock(tmp_path, monkeypatch):
    import sys
    import fcntl
    import collect_us as us

    monkeypatch.setattr(pd.Timestamp, "now", lambda tz: US_NOW)
    us_seed(tmp_path)
    before = {path: path.read_bytes() for path in tmp_path.rglob("*.json")}
    for mode, outcome in (("--plan", 0), ("--check", 1)):
        monkeypatch.setattr(sys, "argv", ["collect_us.py", "--cache", str(tmp_path), mode, "V"])
        monkeypatch.setattr(us, "Downloader", lambda **_: pytest.fail("read-only mode must not construct downloader"))
        assert us.main() == outcome
        assert {path: path.read_bytes() for path in tmp_path.rglob("*.json")} == before
        assert not (tmp_path / ".collect.lock").exists()
    with (tmp_path / ".collect.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        monkeypatch.setattr(sys, "argv", ["collect_us.py", "--cache", str(tmp_path), "--apply", "--symbols=V"])
        assert us.main() == 0
    assert {path: path.read_bytes() for path in tmp_path.rglob("*.json")} == before


def test_automatic_respects_legacy_three_attempts_and_dst(tmp_path):
    import collect_us as us

    us_seed(tmp_path)
    downloader = USDownloader()
    assert us.collect(tmp_path, ["V"], downloader, CALENDAR, US_NOW, minimum_interval=0) == 1
    assert not downloader.calls
    assert CALENDAR.session_close("2026-07-06").hour == 20
    assert CALENDAR.session_close("2026-11-23").hour == 21
    assert not CALENDAR.is_session("2026-11-26")
    assert CALENDAR.session_close("2026-11-27").hour == 18


def test_recovery_write_failure_preserves_existing_file(tmp_path, monkeypatch):
    import collect_us as us

    us_seed(tmp_path)
    path = us.path_for(tmp_path, "V")
    before = path.read_bytes()
    replace = us.Path.replace

    def fail_snapshot(src, target):
        if target == path:
            raise OSError("simulated disk failure")
        return replace(src, target)

    monkeypatch.setattr(us.Path, "replace", fail_snapshot)
    assert us.collect(tmp_path, ["V"], USDownloader(), CALENDAR, US_NOW,
                      apply_only=True, minimum_interval=0) == 1
    assert path.read_bytes() == before


def test_next_session_interior_visa_recovery_and_backup_restore(tmp_path):
    from shutil import copytree
    import collect_us as us

    next_day = pd.Timestamp("2026-11-24")
    now = US_NOW + pd.Timedelta(days=1)
    original = us_series()
    following = original.iloc[-1:].set_axis(pd.DatetimeIndex([next_day], name="Date"))
    complete = pd.concat([original, following])
    live = tmp_path / "live"
    live.mkdir()
    snapshot = us.build_snapshot("V", (complete, complete), now, CALENDAR, next_day)
    for series in ("raw", "adjusted"):
        snapshot[series] = [row for row in snapshot[series] if row["tradingDate"] != "2026-11-23"]
    us.publish(us.path_for(live, "V"), dict(version=1, symbol="V", snapshot=snapshot))
    backup = tmp_path / "backup"
    copytree(live, backup)
    before = us.path_for(backup, "V").read_bytes()
    downloader = USDownloader(complete)
    assert us.collect(live, ["V"], downloader, CALENDAR, now, minimum_interval=0) == 0
    assert us.check_cache(live, ["V"], CALENDAR, now) == 0
    assert us.read_json(us.path_for(live, "V"))["snapshot"]["tradingDate"] == "2026-11-24"
    restored = tmp_path / "restored"
    copytree(backup, restored)
    assert us.path_for(restored, "V").read_bytes() == before
    assert us.path_for(restored, "V").stat().st_mode & 0o777 == 0o640
    assert us.check_cache(restored, ["V"], CALENDAR, now) == 1


def test_partial_status_and_rate_limit_cooldown_survive_restart(tmp_path, capsys):
    import collect_us as us

    us_seed(tmp_path)
    us_seed(tmp_path, "AAPL", VISA)
    downloader = USDownloader()
    assert us.collect(tmp_path, ["V", "AAPL"], downloader, CALENDAR, US_NOW, minimum_interval=0) == 0
    assert '"status": "partial-success"' in capsys.readouterr().out
    assert not downloader.calls
    throttled = USDownloader(error=us.RateLimited("rate-limited"))
    assert us.collect(tmp_path, ["V"], throttled, CALENDAR, US_NOW,
                      apply_only=True, minimum_interval=0) == 75
    assert len(throttled.calls) == 1
    assert us.collect(tmp_path, ["V"], downloader, CALENDAR, US_NOW + pd.Timedelta(minutes=30),
                      apply_only=True, minimum_interval=0) == 75
    assert not downloader.calls


def test_only_regular_collection_expires_queue_entries(tmp_path, monkeypatch):
    import os
    import sys
    import collect_us as us

    queue = tmp_path / "queue"
    queue.mkdir()
    expired = queue / "OLD"
    active = queue / "FRESH"
    for path, age in ((expired, 31), (active, 1)):
        path.touch()
        timestamp = (US_NOW - pd.Timedelta(days=age)).timestamp()
        os.utime(path, (timestamp, timestamp))

    monkeypatch.setattr(pd.Timestamp, "now", lambda tz: US_NOW)
    monkeypatch.setattr(us, "Downloader", lambda **kwargs: object())
    monkeypatch.setattr(us, "collect", lambda *args, **kwargs: 0)
    command = ["collect_us.py", "--cache", str(tmp_path), "--queue", str(queue)]
    for mode in ("--plan", "--check", "--apply"):
        monkeypatch.setattr(sys, "argv", [*command, mode, "V"])
        us.main()
        assert expired.exists() and active.exists()
    monkeypatch.setattr(sys, "argv", [*command, "V"])
    assert us.main() == 0
    assert not expired.exists() and active.exists()
