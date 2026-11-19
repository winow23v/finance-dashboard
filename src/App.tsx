import { lazy, Suspense, useEffect, useState } from 'react'
import { Activity, BarChart3, ChevronDown, CircleHelp, Globe2, Home, Landmark, Moon, RefreshCw, Settings, Sun, TrendingUp } from 'lucide-react'
import { financeService } from './services/financeService'
import { Watchlist } from './components/Watchlist'
import { Change, marketNames, price } from './components/QuoteDisplay'
import { guestStorage, type SettingsState } from './storage/guestStorage'
import { marketSymbolKey, type EquityMarket, type MarketSymbol } from './types/marketSymbol'
import type { EquityQuote, FinanceSnapshot, Indicator, Quote } from './types/finance'

const HistoryChart = lazy(() => import('./components/HistoryChart'))

const tabs = [
  { id: 'overview', label: '개요', icon: Home },
  { id: 'domestic', label: '국내시장', icon: BarChart3 },
  { id: 'global', label: '해외시장', icon: Globe2 },
  { id: 'economy', label: '경제지표', icon: Landmark },
  { id: 'trends', label: '키워드 트렌드', short: '트렌드', icon: TrendingUp },
  { id: 'settings', label: '설정', icon: Settings },
] as const
type Tab = typeof tabs[number]['id']

const timestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
const numeral = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
function hashTab(): Tab | undefined {
  return tabs.find(item => '#' + item.id === location.hash)?.id
}
function QuoteCard({ quote, units }: { quote: Quote; units: SettingsState['units'] }) {
  return <article className="panel quote-card">
    <div className="quote-label"><h3>{quote.name}</h3><span>{marketNames[quote.market]}</span></div>
    <strong>{price(quote, units)}</strong>
    <Change quote={quote} detailed />
  </article>
}

function Economics({ indicators, detailed = false }: { indicators: Indicator[]; detailed?: boolean }) {
  return <section className="panel economy-panel">
    <div className="panel-heading"><div><h2><Landmark size={17} aria-hidden="true" /> 주요 경제지표</h2><p>미국 거시경제 지표</p></div></div>
    {indicators.length === 0 ? <p className="state">표시할 경제지표가 없습니다.</p> :
      <ul className={detailed ? 'indicator-list indicator-detail' : 'indicator-list'}>{indicators.map(item => <li key={item.id}>
        <div><h3>{item.name}</h3><small>{item.observationDate} 기준</small></div>
        <strong>{numeral.format(item.value)}{item.unit}</strong>
        {detailed && <dl><div><dt>발표일</dt><dd>{item.releaseDate}</dd></div><div><dt>수집 시각 (KST)</dt><dd>{timestamp.format(new Date(item.collectedAt))}</dd></div></dl>}
      </li>)}</ul>}
  </section>
}

export function App() {
  const [settings, setSettings] = useState(guestStorage.loadSettings)
  const [tab, setTab] = useState<Tab>(() => hashTab() ?? settings.market)
  const [watchlist, setWatchlist] = useState(() => guestStorage.favorites.load())
  const [storageFailures, setStorageFailures] = useState({ favorites: false, settings: false })
  const [snapshot, setSnapshot] = useState<FinanceSnapshot>()
  const [refreshedAt, setRefreshedAt] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [request, setRequest] = useState(0)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    const change = () => setTab(hashTab() ?? guestStorage.loadSettings().market)
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.dataset.colors = settings.colors
    const saved = guestStorage.saveSettings(settings)
    setStorageFailures(current => ({ ...current, settings: !saved }))
  }, [settings])
  useEffect(() => {
    const saved = guestStorage.favorites.save(watchlist)
    setStorageFailures(current => ({ ...current, favorites: !saved }))
  }, [watchlist])
  useEffect(() => {
    let active = true
    financeService.getSnapshot().then(data => {
      if (!active) return
      setSnapshot(data)
      setRefreshedAt(new Date().toISOString())
      setRevision(value => value + 1)
      setPending(false)
    }, () => {
      if (!active) return
      setError(true)
      setPending(false)
    })
    return () => { active = false }
  }, [request])

  const toggle = (symbol: MarketSymbol) => setWatchlist(previous => {
    const key = marketSymbolKey(symbol)
    return previous.some(item => marketSymbolKey(item) === key)
      ? previous.filter(item => marketSymbolKey(item) !== key)
      : [...previous, { market: symbol.market, exchange: symbol.exchange, symbol: symbol.symbol }]
  })
  const refresh = () => {
    setPending(true)
    setError(false)
    setRequest(value => value + 1)
  }

  const current = tabs.find(item => item.id === tab)!
  const market = tab === 'domestic' ? 'KR' : tab === 'global' ? 'US' : undefined
  const regions: EquityMarket[] = market ? [market] : ['KR', 'US']
  const indices = snapshot?.quotes.filter(quote => quote.kind === 'index' && (!market || quote.market === market)) ?? []
  const fx = snapshot?.quotes.find(quote => quote.kind === 'fx')
  const stocks = snapshot?.quotes.filter((quote): quote is EquityQuote => quote.kind === 'stock' || quote.kind === 'etf') ?? []
  const watchlistProps = { stocks, selected: watchlist, onToggle: toggle, units: settings.units }
  const isMarket = tab === 'overview' || market !== undefined
  const navigation = <nav aria-label="주 메뉴">
    {tabs.map(({ id, label, icon: Icon, ...item }) => <a key={id} href={'#' + id} aria-current={id === tab ? 'page' : undefined}>
      <Icon size={19} aria-hidden="true" /><span>{'short' in item ? <><span className="nav-wide">{label}</span><span className="nav-short">{item.short}</span></> : label}</span>
    </a>)}
  </nav>

  return <div className="app">
    <aside className="sidebar">
      <a className="brand" href="#overview"><span><Activity size={23} aria-hidden="true" /></span><strong>Finance<br />Dashboard</strong></a>
      {navigation}
      <div className="sidebar-footer"><CircleHelp size={16} aria-hidden="true" /> {snapshot?.source.simulated ? '샘플 데이터 모드' : '시장 모니터링'}</div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <a className="compact-brand" href="#overview"><Activity size={20} aria-hidden="true" /> Finance Dashboard</a>
        <span className="breadcrumb">Finance Dashboard <span>/</span> {current.label}</span>
        <div className="top-actions">
          {snapshot && <span className="updated">데이터 기준 (KST) <time dateTime={snapshot.updatedAt}>{timestamp.format(new Date(snapshot.updatedAt))}</time>{refreshedAt && <span className="refresh-time"> · 조회 <time dateTime={refreshedAt}>{timestamp.format(new Date(refreshedAt))}</time></span>}</span>}
          <button className="icon-button" onClick={refresh} disabled={pending} aria-label="데이터 새로고침" title="데이터 새로고침"><RefreshCw size={17} /></button>
          <a className="icon-button" href="#settings" aria-label="설정" title="설정"><Settings size={18} /></a>
        </div>
      </header>
      <div className="responsive-nav">{navigation}</div>
      <main>
        <div className="page-heading">
          <div><h1>{tab === 'overview' ? '시장 개요' : current.label}</h1></div>
          {snapshot && <span className="badge">{snapshot.source.label}{snapshot.source.simulated && ' · 샘플 데이터'}</span>}
        </div>
        {snapshot?.source.simulated && <div className="notice"><CircleHelp size={16} aria-hidden="true" /><span>API 미연결 · 모든 표시 수치는 샘플입니다.</span></div>}
        {(storageFailures.favorites || storageFailures.settings) && <p className="notice" role="status">브라우저에 변경사항을 저장하지 못했습니다. 현재 화면에서만 유지됩니다.</p>}
        {pending && <p className={snapshot ? 'refresh-status' : 'panel state'} role="status">데이터를 불러오는 중입니다.</p>}
        {error && <div className="panel state"><p role="alert">데이터 갱신에 실패했습니다.</p><button className="button" onClick={refresh}>다시 시도</button></div>}
        <Suspense fallback={<p className="panel state" role="status">차트를 준비하는 중입니다.</p>}>
        {snapshot && isMarket && <>
          <section aria-label="핵심 지표">
            <div className="section-heading"><h2>핵심 지표</h2>
              <div className="market-statuses">
                {regions.map(region =>
                  <span className="market-status" key={region}>{marketNames[region]} · {snapshot.marketStatus[region] === 'open' ? '운영 중' : '장 마감'}</span>
                )}
              </div>
            </div>
            {indices.length ? <div className={market ? 'quote-grid' : 'quote-grid overview-quotes'}>
              {indices.map(quote => <QuoteCard key={quote.id} quote={quote} units={settings.units} />)}
            </div> : <p className="panel state">표시할 지수가 없습니다.</p>}
            {tab === 'overview' && <section className="panel fx-summary" aria-label="환율">
              <h2><Globe2 size={16} aria-hidden="true" /> USD/KRW</h2>
              {fx ? <><strong>{price(fx, settings.units)}</strong><Change quote={fx} detailed />
                <time dateTime={fx.asOf} title="환율 기준 시각 (KST)">{timestamp.format(new Date(fx.asOf))}{fx.delayed && ' · 지연'}</time></>
                : <small>환율 데이터가 없습니다.</small>}
            </section>}
          </section>
          <div className={tab === 'overview' ? 'market-layout' : 'market-sections'}>
            <HistoryChart key={'chart:' + tab} items={indices} revision={revision} />
            <Watchlist key={'watchlist:' + tab} {...watchlistProps} market={market} />
          </div>
          {tab === 'overview' && <Economics indicators={snapshot.indicators} />}
        </>}
        {snapshot && tab === 'economy' && <Economics indicators={snapshot.indicators} detailed />}
        {snapshot && tab === 'trends' && <HistoryChart keyword items={snapshot.trendTopics.map(name => ({ id: name, name }))} revision={revision} />}
        </Suspense>
        {tab === 'settings' && <>
          <section className="panel settings-panel">
            <div className="panel-heading"><h2>화면 설정</h2></div>
            <div className="setting"><div><strong>테마</strong><small>화면 색상 모드</small></div>
              <div className="periods" role="group" aria-label="테마">
                <button aria-pressed={settings.theme === 'dark'} onClick={() => setSettings({ ...settings, theme: 'dark' })}><Moon size={15} /> 다크</button>
                <button aria-pressed={settings.theme === 'light'} onClick={() => setSettings({ ...settings, theme: 'light' })}><Sun size={15} /> 라이트</button>
              </div>
            </div>
            <SettingSelect label="기본 표시 시장" description="대시보드를 처음 열 때 표시" value={settings.market} options={{ overview: '개요', domestic: '국내시장', global: '해외시장' }} onChange={market => setSettings({ ...settings, market })} />
            <SettingSelect label="데이터 표시 단위" description="큰 종목 가격의 표시 방식" value={settings.units} options={{ full: '전체 숫자', compact: '간략 단위' }} onChange={units => setSettings({ ...settings, units })} />
            <SettingSelect label="상승·하락 색상" description="등락 방향별 색상" value={settings.colors} options={{ green: '상승 초록 · 하락 빨강', red: '상승 빨강 · 하락 파랑' }} onChange={colors => setSettings({ ...settings, colors })} />
            <div className="setting"><strong>데이터 연결</strong><span>{snapshot ? (snapshot.source.simulated ? 'Mock 사용 중 · API 미연결' : snapshot.source.label) : '데이터 소스 확인 중'}</span></div>
          </section>
          <section className="panel settings-panel">
            <div className="panel-heading"><h2>관심종목 및 설정 저장</h2></div>
            <div className="setting"><strong>게스트 · 이 브라우저</strong><span>계정 로그인 및 기기 간 동기화 준비 중</span></div>
            <p className="storage-note">공유 기기에서는 같은 브라우저 프로필의 사용자가 저장된 목록을 볼 수 있습니다. 사이트 데이터를 지우면 저장값이 삭제됩니다.</p>
          </section>
          {snapshot && <Watchlist {...watchlistProps} />}
        </>}
        <footer>Finance Dashboard{snapshot?.source.simulated && ' · 샘플 데이터'}</footer>
      </main>
    </div>
  </div>
}

function SettingSelect<T extends string>({ label, description, value, options, onChange }: {
  label: string; description: string; value: T; options: Record<T, string>; onChange: (value: T) => void
}) {
  return <label className="setting"><span><strong>{label}</strong><small>{description}</small></span>
    <span className="select-wrap"><select value={value} onChange={event => onChange(event.target.value as T)}>
      {(Object.keys(options) as T[]).map(key => <option key={key} value={key}>{options[key]}</option>)}
    </select><ChevronDown aria-hidden="true" size={16} /></span>
  </label>
}
