import { useId, useMemo, useState, type CSSProperties } from 'react'
import { stockHref } from '../services/marketListings'
import { heatmapColor, heatmapTextColor, layoutHeatmap, parseMarketHeatmap, type HeatmapListing, type HeatmapRect } from '../services/marketHeatmap'
import { marketSymbolKey, type EquityMarket, type MarketSymbol } from '../types/marketSymbol'

const price = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 })
const change = new Intl.NumberFormat('ko-KR', { maximumSignificantDigits: 15, signDisplay: 'exceptZero' })
const timestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
const atKst = (at: string) => timestamp.format(new Date(at))
const rate = (item: HeatmapListing) => change.format(item.quote.percentChange) + '%'
const rectStyle = (rect: HeatmapRect): CSSProperties => ({
  left: rect.x + '%', top: rect.y + '%', width: rect.width + '%', height: rect.height + '%',
})

export function MarketHeatmap({ market, favorites, data }: {
  market: EquityMarket; favorites: readonly MarketSymbol[]; data?: unknown
}) {
  const snapshot = useMemo(() => parseMarketHeatmap(data, market), [data, market])
  const [sector, setSector] = useState('')
  const [query, setQuery] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [active, setActive] = useState<string>()
  const tooltipId = useId()
  const sectors = [...new Set(snapshot?.listings.map(item => item.sector) ?? [])].sort((a, b) => a.localeCompare(b, 'ko'))
  const selectedSector = sectors.includes(sector) ? sector : ''
  const groups = useMemo(() => {
    const saved = new Set(favorites.map(marketSymbolKey))
    const terms = query.toLocaleLowerCase('ko-KR').trim().split(/\s+/).filter(Boolean)
    const groups = new Map<string, { sector: string; cap: number; listings: HeatmapListing[] }>()
    for (const item of snapshot?.listings ?? []) {
      if ((selectedSector && selectedSector !== item.sector) || (favoritesOnly && !saved.has(marketSymbolKey(item.listing)))) continue
      const search = [item.name, item.listing.symbol, item.listing.exchange].join(' ').toLocaleLowerCase('ko-KR')
      if (!terms.every(term => search.includes(term))) continue
      const group = groups.get(item.sector) ?? { sector: item.sector, cap: 0, listings: [] }
      group.cap += item.marketCap
      group.listings.push(item)
      groups.set(item.sector, group)
    }
    return layoutHeatmap([...groups.values()], group => group.cap)
      .map(group => ({ ...group, tiles: layoutHeatmap(group.row.listings, item => item.marketCap, group.rect) }))
  }, [snapshot, selectedSector, favorites, favoritesOnly, query])
  const activeItem = active && groups.flatMap(group => group.row.listings)
    .find(item => marketSymbolKey(item.listing) === active)
  const title = (market === 'KR' ? '국내' : '해외') + ' 시장 히트맵'

  return <section className="panel market-heatmap" aria-label={title}>
    <div className="section-heading"><h2>{title}</h2>
      <div className="heatmap-legend" aria-label="등락률 색상 범위">
        {[-3, 0, 3].map(percent => <span key={percent}>
          <i aria-hidden="true" style={{ background: heatmapColor(market, percent) }} />{change.format(percent)}%
        </span>)}
      </div>
    </div>
    {!snapshot ? <p className="state" role="status">시세·시가총액·업종 데이터 미연결</p> : <>
      <p className="heatmap-meta">{snapshot.tradingDate} 기준 · {snapshot.session === 'open' ? '장중' : snapshot.session === 'closed' ? '장 마감' : '휴장'}
        {' · '}{snapshot.timing.kind === 'delayed' ? `${snapshot.timing.minutes}분 지연` : snapshot.timing.kind === 'realtime' ? '실시간' : '확정 종가'}
        {' · '}{snapshot.adjustment === 'split-adjusted' ? '분할 수정주가' : '미수정주가'}</p>
      <div className="heatmap-controls">
        <label>업종 <select value={selectedSector} onChange={event => { setSector(event.target.value); setActive(undefined) }}>
          <option value="">전체</option>
          {sectors.map(name => <option key={name}>{name}</option>)}
        </select></label>
        <label>종목 검색 <input type="search" value={query} maxLength={64}
          onChange={event => { setQuery(event.target.value); setActive(undefined) }} /></label>
        <label><input type="checkbox" checked={favoritesOnly}
          onChange={event => { setFavoritesOnly(event.target.checked); setActive(undefined) }} /> 관심종목만</label>
      </div>
      {groups.length ? <>
        <p className="heatmap-meta">타일 면적은 표시 중인 종목의 시가총액에 비례합니다. 시가총액 기준일 {snapshot.listings[0].marketCapDate}</p>
        <div className="heatmap-map">
          {groups.map(({ row, rect, tiles }) => <div key={row.sector} role="group" aria-label={row.sector}>
            {tiles.map(({ row: item, rect }) => {
              const key = marketSymbolKey(item.listing)
              const background = heatmapColor(market, item.quote.percentChange)
              return <a key={key} className="heatmap-tile" href={stockHref(item.listing)}
                aria-label={`${item.name} ${item.listing.symbol}, ${rate(item)}, ${price.format(item.quote.value)} ${item.quote.currency}`}
                aria-describedby={active === key ? tooltipId : undefined}
                onMouseEnter={() => setActive(key)} onMouseLeave={() => setActive(undefined)}
                onFocus={() => setActive(key)} onBlur={() => setActive(undefined)}
                onKeyDown={event => { if (event.key === 'Escape') setActive(undefined) }}
                style={{ ...rectStyle(rect), background, color: heatmapTextColor(background) }}>
                <span className="heatmap-ticker">{item.listing.symbol}</span>
                <span className="heatmap-rate">{rate(item)}</span>
                <span className="heatmap-price">{price.format(item.quote.value)} {item.quote.currency}</span>
              </a>
            })}
            <div aria-hidden="true" className="heatmap-sector" style={rectStyle(rect)}>
              {rect.width >= 18 && rect.height >= 18 && <span>{row.sector}</span>}
            </div>
          </div>)}
          {activeItem && <div className="panel heatmap-tooltip" id={tooltipId} role="tooltip">
            <strong>{activeItem.name} · {activeItem.listing.symbol}</strong>
            <small>{activeItem.sector} · {price.format(activeItem.quote.value)} {activeItem.quote.currency} · {rate(activeItem)}</small>
            <small>시가총액 {price.format(activeItem.marketCap)} {activeItem.quote.currency}</small>
            <small>관측 {activeItem.quote.observation.kind === 'instant'
              ? atKst(activeItem.quote.observation.at) + ' (KST)' : activeItem.quote.observation.date}</small>
          </div>}
        </div>
      </> : <p className="state" role="status">조건에 맞는 종목이 없습니다.</p>}
      <dl className="heatmap-sources">
        {([['시세', snapshot.sources.quote], ['시가총액', snapshot.sources.marketCap], ['업종', snapshot.sources.sector]] as const)
          .map(([label, source]) => <div key={label}><dt>{label}</dt><dd>
            <a href={source.url}>{source.label}</a> · 수집 <time dateTime={source.collectedAt}>{atKst(source.collectedAt)}</time> (KST)
            {source.attributionNotice && <small>{source.attributionNotice}</small>}
          </dd></div>)}
      </dl>
    </>}
  </section>
}
