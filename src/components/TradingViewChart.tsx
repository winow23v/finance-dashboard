import { useEffect, useRef, useState } from 'react'
import type { TradingViewSymbol } from '../services/tradingViewSymbols'

const scriptUrl = 'https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js'
const tradingViewUrl = (symbol: string) => 'https://www.tradingview.com/symbols/' + symbol.replace(':', '-') + '/'

function SymbolOverview({ symbol, name, theme }: { symbol: string; name: string; theme: 'dark' | 'light' }) {
  const container = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const symbolUrl = tradingViewUrl(symbol)

  useEffect(() => {
    const host = container.current
    if (!host) return
    const embed = document.createElement('div')
    embed.className = 'tradingview-widget-container'
    const widget = document.createElement('div')
    widget.className = 'tradingview-widget-container__widget'
    const attribution = document.createElement('div')
    attribution.className = 'tradingview-widget-copyright'
    const link = document.createElement('a')
    link.href = symbolUrl
    link.target = '_blank'
    link.rel = 'noopener nofollow'
    const text = document.createElement('span')
    text.className = 'blue-text'
    text.textContent = name + ' 차트'
    const trademark = document.createElement('span')
    trademark.className = 'trademark'
    trademark.textContent = ' by TradingView'
    link.append(text)
    attribution.append(link, trademark)

    const script = document.createElement('script')
    script.src = scriptUrl
    script.async = true
    script.textContent = JSON.stringify({
      symbols: [[name, symbol + '|1D']],
      width: '100%', height: '100%', autosize: true,
      colorTheme: theme, locale: 'kr', chartType: 'area',
      dateRanges: ['1m|1D', '3m|1D', '12m|1D'],
      showVolume: false, hideDateRanges: false, isTransparent: false,
    })

    let frame: HTMLIFrameElement | null = null
    let active = true
    const ready = () => {
      if (!active) return
      window.clearTimeout(timeout)
      setStatus('ready')
    }
    const fail = () => {
      if (!active) return
      active = false
      window.clearTimeout(timeout)
      observer.disconnect()
      embed.remove()
      setStatus('error')
    }
    const observer = new MutationObserver(() => {
      const next = embed.querySelector('iframe')
      if (!next || next === frame) return
      frame?.removeEventListener('load', ready)
      frame?.removeEventListener('error', fail)
      frame = next
      frame.title = name + ' TradingView 차트'
      frame.addEventListener('load', ready, { once: true })
      frame.addEventListener('error', fail, { once: true })
    })
    const blocked = (event: SecurityPolicyViolationEvent) => {
      if (/^https:\/\/(?:[^/]+\.)?tradingview(?:-widget)?\.(?:com|net)(?::\d+)?(?:\/|$)/.test(event.blockedURI)) fail()
    }
    const timeout = window.setTimeout(fail, 12_000)
    document.addEventListener('securitypolicyviolation', blocked)
    script.addEventListener('error', fail, { once: true })
    observer.observe(embed, { childList: true, subtree: true })
    embed.append(widget, attribution, script)
    const mount = window.requestAnimationFrame(() => { if (active) host.append(embed) })

    return () => {
      active = false
      window.clearTimeout(timeout)
      window.cancelAnimationFrame(mount)
      observer.disconnect()
      document.removeEventListener('securitypolicyviolation', blocked)
      script.removeEventListener('error', fail)
      frame?.removeEventListener('load', ready)
      frame?.removeEventListener('error', fail)
      embed.remove()
    }
  }, [name, symbol, symbolUrl, theme])

  return <>
    {status === 'loading' && <p role="status" className="chart-note">TradingView 차트를 불러오는 중입니다.</p>}
    {status === 'error' && <p role="status" className="chart-note">TradingView 차트를 불러오지 못했습니다.</p>}
    <div ref={container} className="tradingview-surface" hidden={status === 'error'} />
    <p className="chart-note"><a href={symbolUrl} target="_blank" rel="noopener noreferrer">TradingView에서 종목 열기</a></p>
  </>
}

export default function TradingViewChart({ id, chart, name, theme, onClose }: {
  id: string; chart?: TradingViewSymbol; name: string; theme: 'dark' | 'light'; onClose: () => void
}) {
  const symbol = chart?.symbol
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [name, symbol])
  return <section id={id} className="panel chart-panel tradingview-panel" aria-labelledby={id + '-title'}>
    <div className="panel-heading">
      <div><h2 id={id + '-title'} ref={heading} tabIndex={-1}>{name} 차트</h2>
        {symbol && <p>TradingView 제공 · {symbol}</p>}</div>
      <button type="button" className="button" onClick={onClose}>차트 닫기</button>
    </div>
    {chart?.embeddable ? <SymbolOverview key={`${chart.symbol}:${theme}`} symbol={chart.symbol} name={name} theme={theme} />
      : <div className="state">
        <p role="status">{symbol ? 'TradingView에서 이 종목의 외부 위젯 표시를 제한합니다.' : '이 종목의 TradingView 위젯은 지원되지 않습니다.'}</p>
        {symbol && <a href={tradingViewUrl(symbol)} target="_blank" rel="noopener noreferrer">TradingView에서 종목 열기</a>}
      </div>}
  </section>
}
