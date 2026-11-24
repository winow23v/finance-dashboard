import { useId, useMemo, useRef, useState } from 'react'
import { heatmapColor, heatmapTextColor, layoutHeatmap } from '../services/marketHeatmap'
import { stockHref } from '../services/marketListings'
import type { KrxMarket, KrxMarketRow, KrxOverview } from '../types/finance'
import { krxStateLabels } from './KrxStocks'

const number = new Intl.NumberFormat('ko-KR')
const percent = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2, signDisplay: 'exceptZero' })
const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
const link = (row: KrxMarketRow) => stockHref({ market: 'KR', exchange: 'XKRX', symbol: row.symbol })
const rate = (row: KrxMarketRow) => row.changePercent === null ? '등락률 미확인' : percent.format(row.changePercent) + '%'
const state = (data?: KrxOverview | null) => data === undefined ? 'KRX 시장 데이터를 불러오는 중입니다.'
  : data === null ? 'KRX 시장 데이터를 조회하지 못했습니다.'
    : data.reason && data.reason !== 'same-date-data-unavailable' ? krxStateLabels[data.reason]
      : '두 시장의 동일 거래일 자료를 확인할 수 없습니다.'
const description = (data: KrxOverview) => [
  data.tradingDate && '확정 종가 기준 ' + data.tradingDate, data.source,
  data.usingPreviousClose && '이전 정상 종가 사용',
  data.collectedAt && '마지막 정상 수집 ' + time.format(new Date(data.collectedAt)) + ' (KST)',
  data.lastAttemptAt && '마지막 시도 ' + time.format(new Date(data.lastAttemptAt)) + ' (KST)',
  data.reason && data.reason !== 'same-date-data-unavailable' ? krxStateLabels[data.reason] : null,
].filter(Boolean).join(' · ')

const rankings = [
  { key: 'advances', label: '상승률 상위', format: rate },
  { key: 'declines', label: '하락률 상위', format: rate },
  { key: 'volume', label: '거래량 상위', format: (row: KrxMarketRow) => number.format(row.volume) + '주' },
  { key: 'turnover', label: '거래대금 상위', format: (row: KrxMarketRow) =>
    row.turnover == null ? '거래대금 미확인' : number.format(row.turnover) + '원' },
] as const

export function KrxMovers({ data, message, summary }: { data?: KrxOverview | null; message?: string; summary?: boolean }) {
  const leaders = data?.leaders
  return <section className="panel movers-panel" aria-label="주요 등락 현황">
    <div className="section-heading"><h2>주요 등락 현황</h2>{summary && <a href="#domestic" className="text-link">국내시장 보기</a>}</div>
    {!data || !leaders ? <p className="state" role="status">{message ?? state(data)}</p> : <>
      <p className="heatmap-meta">{description(data)}</p>
      <div className="krx-rankings">
        {(summary ? rankings.slice(0, 2) : rankings).map(({ key, label, format }) => {
          const rows = leaders[key]
          if (!rows) return null
          return <div key={key}>
            <h3>{label}</h3>
            {rows.length ? <ol className="stock-list">
              {(summary ? rows.slice(0, 3) : rows).map(row => <li key={row.market + ':' + row.symbol}>
                <a className="stock-detail-link" href={link(row)}>{row.name}{!row.mapped && ' (명칭 미매핑)'}<small>{row.market} · {row.symbol}</small></a>
                <span>{format(row)}</span>
              </li>)}
            </ol> : <p className="state">해당 종목 없음</p>}
          </div>
        })}
      </div>
    </>}
  </section>
}

export function KrxHeatmap({ data, message, summary }: { data?: KrxOverview | null; message?: string; summary?: boolean }) {
  const [filter, setFilter] = useState<KrxMarket | ''>('')
  const [active, setActive] = useState<{ key: string; pinned: boolean }>()
  const touch = useRef(false)
  const tooltip = useId()
  const selected = useMemo(() => {
    const rows = filter ? data?.marketTiles[filter] : data?.tiles
    return summary ? rows?.filter(row => (row.marketCap ?? 0) > 0 && row.changePercent !== null).slice(0, 12) : rows
  }, [data, filter, summary])
  const key = (row: KrxMarketRow) => row.market + ':' + row.symbol
  const focused = selected?.find(row => key(row) === active?.key)
  const groups = useMemo(() => layoutHeatmap(['KOSPI', 'KOSDAQ'].flatMap(market => {
    const rows = selected?.filter(row => row.market === market && row.marketCap !== null && row.marketCap > 0 && row.changePercent !== null) ?? []
    return rows.length ? [{ market, rows, cap: rows.reduce((sum, row) => sum + (row.marketCap ?? 0), 0) }] : []
  }), group => group.cap).map(group => ({
    ...group, tiles: layoutHeatmap(group.row.rows, row => row.marketCap ?? 0, group.rect),
  })), [selected])
  return <section className={summary ? "panel market-heatmap overview-heatmap" : "panel market-heatmap"} aria-label="국내 시장 히트맵">
    <div className="section-heading"><h2>국내 시장 히트맵</h2>
      {summary && <a className="text-link" href="#domestic">상세보기</a>}
    </div>
    {data?.tradingDate && groups.length ? <>
      <div className="heatmap-controls">
        {!summary && <label>시장 <select value={filter} onChange={event => {
          setFilter(event.target.value as KrxMarket | '')
          setActive(undefined)
        }}><option value="">전체</option><option>KOSPI</option><option>KOSDAQ</option></select></label>}
        <div className="heatmap-legend" aria-label="등락률 색상 범례">
          {([[-3, '하락'], [0, '보합'], [3, '상승']] as const).map(([value, label]) => <span key={value}>
            <i aria-hidden="true" style={{ background: heatmapColor('KR', value) }} />{label} {percent.format(value)}%
          </span>)}
        </div>
      </div>
      <p className="heatmap-meta">{description(data)} · 시가총액 상위 {selected?.length}종목</p>
      <div className="krx-heatmap-layout">
        <div className="heatmap-map">
          {groups.map(({ row, tiles }) => <div key={row.market} role="group" aria-label={row.market}>
            {tiles.map(({ row: item, rect }) => {
              if (item.changePercent === null) return null
              const background = heatmapColor('KR', item.changePercent)
              const itemKey = key(item)
              const label = item.name + ' · ' + item.symbol + ' · ' + rate(item) + (item.mapped ? '' : ' · 명칭 미매핑')
              return <a key={itemKey} href={link(item)} className="heatmap-tile" aria-label={label}
                aria-describedby={active?.key === itemKey ? tooltip : undefined}
                onPointerEnter={event => { if (event.pointerType === 'mouse') setActive({ key: itemKey, pinned: false }) }}
                onPointerLeave={() => { if (!active?.pinned) setActive(undefined) }}
                onPointerDown={event => { touch.current = event.pointerType === 'touch' }}
                onClick={event => {
                  if (!summary && touch.current && event.detail !== 0) {
                    event.preventDefault()
                    setActive({ key: itemKey, pinned: true })
                  }
                  touch.current = false
                }}
                onFocus={() => setActive({ key: itemKey, pinned: false })}
                onBlur={() => { if (!active?.pinned) setActive(undefined) }}
                onKeyDown={event => { if (event.key === 'Escape') setActive(undefined) }}
                style={{ left: rect.x + '%', top: rect.y + '%', width: rect.width + '%', height: rect.height + '%',
                  background, color: heatmapTextColor(background) }}>
                <span className="heatmap-ticker">{item.shortName}</span><span className="heatmap-rate">{rate(item)}</span>
              </a>
            })}
          </div>)}
        </div>
        <details className="krx-heatmap-list">
          <summary>{summary ? '시가총액 상위 5종목' : '종목 목록으로 보기'}</summary>
          <ul className="stock-list">
            {(summary ? selected?.slice(0, 5) ?? [] : groups.flatMap(group => group.tiles.map(tile => tile.row))).map(row => <li key={key(row)}>
              <a className="stock-detail-link" href={link(row)}>{row.shortName}<small>{row.market} · {row.symbol}</small></a>
              <span>{rate(row)}</span>
            </li>)}
          </ul>
        </details>
        {(!summary || focused) && <aside className="panel krx-heatmap-detail" aria-label="히트맵 종목 정보">
          {focused ? <>
            <div id={tooltip} role={active?.pinned ? undefined : 'tooltip'}><KrxTileInfo row={focused} /></div>
            {active?.pinned && <div className="krx-tile-selection">
              <a className="button" href={link(focused)}>종목 상세 보기</a>
              <button className="button" onClick={() => setActive(undefined)}>닫기</button>
            </div>}
          </> : <p className="heatmap-meta">타일을 가리키거나 선택하면 종목 정보를 볼 수 있습니다.</p>}
        </aside>}
      </div>
    </> : <p className="state" role="status">{message ?? state(data)}</p>}
  </section>
}

function KrxTileInfo({ row }: { row: KrxMarketRow }) {
  return <>
    <strong>{row.name} · {row.symbol}{!row.mapped && ' · 명칭 미매핑'}</strong>
    <small>{row.market} · 종가 {number.format(row.price)}원 · {rate(row)}</small>
    <small>시가총액 {row.marketCap === null ? '미확인' : number.format(row.marketCap) + '원'}</small>
  </>
}
