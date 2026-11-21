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
