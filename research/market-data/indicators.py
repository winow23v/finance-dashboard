"""Daily indicators. Missing warm-up observations are reported as null."""
import math

import pandas as pd


def ema(series, period):
    valid = series.dropna()
    if len(valid) < period:
        return pd.Series(float("nan"), index=series.index, dtype=float)
    seed = pd.Series([valid.iloc[:period].mean()], index=valid.index[period - 1:period])
    return pd.concat([seed, valid.iloc[period:]]).ewm(span=period, adjust=False).mean().reindex(series.index)


def last(series):
    value = float(series.iloc[-1])
    return value if math.isfinite(value) else None


def window_return(close, months):
    target = close.index[-1] - pd.DateOffset(months=months)
    previous = close.loc[:target]
    return None if previous.empty else float(close.iloc[-1] / previous.iloc[-1] - 1)


def rsi(close, period=14):
    differences = close.diff().dropna()
    if len(differences) < period:
        return None
    gain = differences.clip(lower=0)
    loss = -differences.clip(upper=0)
    avg_gain, avg_loss = gain.iloc[:period].mean(), loss.iloc[:period].mean()
    for up, down in zip(gain.iloc[period:], loss.iloc[period:]):
        avg_gain = (avg_gain * (period - 1) + up) / period
        avg_loss = (avg_loss * (period - 1) + down) / period
    if avg_loss == 0:
        return 50.0 if avg_gain == 0 else 100.0
    return float(100 - 100 / (1 + avg_gain / avg_loss))


def calculate(frame):
    close = frame["Close"]
    macd = ema(close, 12) - ema(close, 26)
    signal = ema(macd, 9)
    return {
        "sma": {str(period): last(close.rolling(period).mean()) for period in (20, 50, 200)},
        "ema": {str(period): last(ema(close, period)) for period in (20, 50, 100, 200)},
        "rsi14": rsi(close),
        "macd": {"line": last(macd), "signal": last(signal), "histogram": last(macd - signal)},
        "volumeSma20": last(frame["Volume"].rolling(20).mean()),
        "changeRate": last(close.pct_change(fill_method=None)),
        "returns": {f"{months}M": window_return(close, months) for months in (1, 3, 6)},
    }
