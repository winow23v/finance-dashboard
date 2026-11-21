import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Activity, BarChart3, ChevronDown, CircleHelp, Globe2, Home, Landmark, Moon, RefreshCw, Settings, Sun, TrendingUp } from 'lucide-react'
import { dataMode, financeService } from './services/financeService'
import { Disclosures } from './components/Disclosures'
import { KoreaEconomy } from './components/KoreaEconomy'
import { DataStatus } from './components/DataStatus'
import { Economics } from './components/Economics'
import { informationPages, SiteInformation, type InformationPage } from './components/SiteInformation'
import { Watchlist } from './components/Watchlist'
import { Change, marketNames, price } from './components/QuoteDisplay'
import { guestStorage, type SettingsState } from './storage/guestStorage'
import { marketSymbolKey, type EquityMarket, type MarketSymbol } from './types/marketSymbol'
import type { EquityQuote, FinanceSnapshot, Quote } from './types/finance'

const FxDashboard = lazy(() => import('./components/FxDashboard'))
const HistoryChart = lazy(() => import('./components/HistoryChart'))
const isApi = dataMode === 'api'

const tabs = [
  { id: 'overview', label: '개요', icon: Home },
  { id: 'domestic', label: '국내시장', icon: BarChart3 },
  { id: 'global', label: '해외시장', icon: Globe2 },
  { id: 'economy', label: '경제지표', icon: Landmark },
  { id: 'trends', label: '키워드 트렌드', short: '트렌드', icon: TrendingUp },
  { id: 'settings', label: '설정', icon: Settings },
] as const
type Tab = typeof tabs[number]['id']
type Page = Tab | InformationPage
type FavoriteChart = { key: string; name: string }

const timestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
function hashPage(): Page | undefined {
  const hash = location.hash.slice(1)
  if (Object.hasOwn(informationPages, hash)) return hash as InformationPage
  return tabs.find(item => item.id === hash)?.id
}
function QuoteCard({ quote, simulated, units, onOpen }: {
  quote: Quote; simulated: boolean; units: SettingsState['units']; onOpen: () => void
}) {
  return <article className="panel quote-card quote-chart-area">
    <div className="quote-label"><h3>{quote.name}</h3><span>{marketNames[quote.market]}{simulated ? ' · DEMO' : quote.delayed ? ' · 지연' : ''}</span></div>
    <strong>{price(quote, units)}</strong>
    <Change quote={quote} detailed />
    {!simulated && <small>시세 기준 (KST) <time dateTime={quote.asOf}>{timestamp.format(new Date(quote.asOf))}</time></small>}
    <button type="button" className="index-chart-trigger" aria-label={quote.name + ' 시세 차트'}
      aria-controls="market-history" onClick={onOpen}>시세 차트</button>
  </article>
}

export function App() {
  const [settings, setSettings] = useState(guestStorage.loadSettings)
  const [tab, setTab] = useState<Page>(() => hashPage() ?? settings.market)
  const [watchlist, setWatchlist] = useState(() => guestStorage.favorites.load())
  const [storageFailures, setStorageFailures] = useState({ favorites: false, settings: false })
  const [snapshot, setSnapshot] = useState<FinanceSnapshot>()
  const [refreshedAt, setRefreshedAt] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [request, setRequest] = useState(0)
  const [dartRevision, setDartRevision] = useState(0)
  const [economyRevision, setEconomyRevision] = useState(0)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState(false)
  const [chartSelection, setChartSelection] = useState<string>()
  const [favoriteChart, setFavoriteChart] = useState<FavoriteChart>()
  const favoriteTrigger = useRef<HTMLButtonElement>(null)
  const favoriteTitleRef = useCallback((heading: HTMLHeadingElement | null) => { heading?.focus() }, [])
  const [chartOpenCount, setChartOpenCount] = useState(0)
  const focusChartOnOpen = useRef(false)
  const chartTitleRef = useCallback((heading: HTMLHeadingElement | null) => {
    if (heading && focusChartOnOpen.current) {
      focusChartOnOpen.current = false
      heading.focus()
    }
  }, [])
  const showEconomy = tab === 'overview' || tab === 'economy'
  const [visitedEconomy, setVisitedEconomy] = useState(showEconomy)

  useEffect(() => {
    if (showEconomy) setVisitedEconomy(true)
  }, [showEconomy])
  useEffect(() => {
    const change = () => setTab(hashPage() ?? guestStorage.loadSettings().market)
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  useEffect(() => {
    setFavoriteChart(undefined)
    favoriteTrigger.current = null
  }, [tab])
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

  const toggle = (symbol: MarketSymbol) => {
    const key = marketSymbolKey(symbol)
    if (favoriteChart?.key === key) {
      setFavoriteChart(undefined)
      favoriteTrigger.current = null
    }
    setWatchlist(previous => previous.some(item => marketSymbolKey(item) === key)
      ? previous.filter(item => marketSymbolKey(item) !== key)
      : [...previous, { market: symbol.market, exchange: symbol.exchange, symbol: symbol.symbol }])
  }

  const closeFavoriteChart = () => {
    favoriteTrigger.current?.focus()
    favoriteTrigger.current = null
    setFavoriteChart(undefined)
  }
  const openFavoriteChart = (next: FavoriteChart, trigger: HTMLButtonElement) => {
    if (favoriteChart?.key === next.key) closeFavoriteChart()
    else {
      favoriteTrigger.current = trigger
      setFavoriteChart(next)
    }
  }
  const refresh = () => {
    setPending(true)
    setError(false)
    setRequest(value => value + 1)
    if (tab === 'domestic') setDartRevision(value => value + 1)
    if (showEconomy) setEconomyRevision(value => value + 1)
  }

  const current = tabs.find(item => item.id === tab)
  const information = current ? undefined : tab as InformationPage
  const pageLabel = current?.label ?? (information && informationPages[information])
  const market = tab === 'domestic' ? 'KR' : tab === 'global' ? 'US' : undefined
  const regions: EquityMarket[] = market ? [market] : ['KR', 'US']
  const indices = snapshot?.quotes.filter(quote => quote.kind === 'index' && (!market || quote.market === market)) ?? []
  const fx = snapshot?.quotes.find(quote => quote.kind === 'fx')
  const stocks = snapshot?.quotes.filter((quote): quote is EquityQuote => quote.kind === 'stock' || quote.kind === 'etf') ?? []
  const simulated = snapshot?.source.simulated ?? false
  const watchlistProps = {
    simulated, stocks, selected: watchlist, onToggle: toggle, units: settings.units,
    catalogUnavailable: isApi && !!snapshot && stocks.length === 0,
    activeChartKey: favoriteChart?.key,
    onOpenChart: (listing: MarketSymbol, name: string, trigger: HTMLButtonElement) => {
      openFavoriteChart({ key: marketSymbolKey(listing), name }, trigger)
    },
  }
  const favoriteChartPanel = favoriteChart && <Suspense fallback={<p className="panel state" role="status">차트를 준비하는 중입니다.</p>}>
    <HistoryChart key={favoriteChart.key} items={[]} simulated={false} revision={revision} favoriteName={favoriteChart.name}
      onClose={closeFavoriteChart} titleRef={favoriteTitleRef} />
  </Suspense>
  const isMarket = tab === 'overview' || market !== undefined
  const openIndexChart = (id: string) => {
    focusChartOnOpen.current = true
    setChartSelection(id)
    setChartOpenCount(value => value + 1)
  }
  const navigation = <nav aria-label="주 메뉴">
    {tabs.map(({ id, label, icon: Icon, ...item }) => <a key={id} href={'#' + id} aria-current={id === tab ? 'page' : undefined}>
      <Icon size={19} aria-hidden="true" /><span>{'short' in item ? <><span className="nav-wide">{label}</span><span className="nav-short">{item.short}</span></> : label}</span>
    </a>)}
    <a href="#sources" aria-label={informationPages.sources} aria-current={tab === 'sources' ? 'page' : undefined}>
      <CircleHelp size={19} aria-hidden="true" /><span className="nav-wide">{informationPages.sources}</span><span className="nav-short">출처</span>
    </a>
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
        <span className="breadcrumb">Finance Dashboard <span>/</span> {pageLabel}</span>
        {!information && <div className="top-actions">
          {snapshot && tab !== 'economy' && <span className="updated">{simulated ? '샘플 기준' : '데이터 기준'} (KST) <time dateTime={snapshot.updatedAt}>{timestamp.format(new Date(snapshot.updatedAt))}</time>{refreshedAt && <span className="refresh-time"> · 조회 <time dateTime={refreshedAt}>{timestamp.format(new Date(refreshedAt))}</time></span>}</span>}
          <button className="icon-button" onClick={refresh} disabled={pending} aria-label="데이터 새로고침" title="데이터 새로고침"><RefreshCw size={17} /></button>
          <a className="icon-button" href="#settings" aria-label="설정" title="설정"><Settings size={18} /></a>
        </div>}
      </header>
      <div className="responsive-nav">{navigation}</div>
      <main>
        <div className="page-heading">
          <div><h1>{tab === 'overview' ? '시장 개요' : pageLabel}</h1></div>
          {!information && snapshot && tab !== 'economy' && <span className="badge">{snapshot.source.label}{snapshot.source.simulated && ' · 샘플 데이터'}</span>}
        </div>
        {information ? <SiteInformation page={information} /> : <>
        {(storageFailures.favorites || storageFailures.settings) && <p className="notice" role="status">브라우저에 변경사항을 저장하지 못했습니다. 현재 화면에서만 유지됩니다.</p>}
        {pending && (!isApi || tab !== 'economy') && <p className={snapshot ? 'refresh-status' : 'panel state'} role="status">데이터를 불러오는 중입니다.</p>}
        {error && (!isApi || tab !== 'economy') && <div className="panel state"><p role="alert">{isApi ? 'API 데이터를 불러오지 못했습니다.' : '데이터 갱신에 실패했습니다.'}</p><button className="button" onClick={refresh}>다시 시도</button></div>}
        <Suspense fallback={<p className="panel state" role="status">차트를 준비하는 중입니다.</p>}>
        {snapshot && isMarket && <>
          <section aria-label="핵심 지표">
            <div className="section-heading"><h2>핵심 지표</h2>
              {!simulated && <div className="market-statuses">
                {regions.map(region =>
                  <span className="market-status" key={region}>{marketNames[region]} · {snapshot.marketStatus[region] === 'open' ? '운영 중' : '장 마감'}</span>
                )}
              </div>}
            </div>
            {indices.length ? <div className={market ? 'quote-grid' : 'quote-grid overview-quotes'}>
              {indices.map(quote => <QuoteCard key={quote.id} quote={quote} simulated={simulated} units={settings.units}
                onOpen={() => openIndexChart(quote.id)} />)}
            </div> : <p className="panel state">실제 시세 데이터 준비 중</p>}
            {tab === 'overview' && !isApi && <section className="panel fx-summary" aria-label="환율">
              <h2><Globe2 size={16} aria-hidden="true" /> USD/KRW{simulated && ' · DEMO'}</h2>
              {fx ? <><strong>{price(fx, settings.units)}</strong><Change quote={fx} detailed />
                <time dateTime={fx.asOf} title="환율 기준 시각 (KST)">{timestamp.format(new Date(fx.asOf))}{fx.delayed && ' · 지연'}</time></>
                : <small>환율 데이터가 없습니다.</small>}
            </section>}
          </section>
          <div className={tab === 'overview' ? 'market-layout' : 'market-sections'}>
            <HistoryChart simulated={simulated} key={`chart:${tab}:${chartOpenCount}`} items={indices} revision={revision}
              selectedId={chartSelection} onSelect={setChartSelection} titleRef={chartTitleRef} />
            <Watchlist key={'watchlist:' + tab} {...watchlistProps} market={market} chartPanel={favoriteChartPanel} />
          </div>
        </>}
        {isApi && tab === 'overview' && <FxDashboard revision={request} />}
        {snapshot && tab === 'trends' && (isApi
          ? <p className="panel state" role="status">현재 API는 키워드 트렌드를 지원하지 않습니다.</p>
          : <HistoryChart keyword simulated={simulated} items={snapshot.trendTopics.map(name => ({ id: name, name }))} revision={revision} />)}
        </Suspense>
        </>}
        {isApi && <div hidden={market !== 'KR'}><Disclosures market="KR" revision={dartRevision} /></div>}
        {isApi && <div hidden={market !== 'US'}><Disclosures market="US" revision={request} /></div>}
        {(showEconomy || visitedEconomy) && (isApi || snapshot) && <div hidden={!showEconomy}>
          {isApi && <KoreaEconomy revision={economyRevision} visible={showEconomy} />}
          <Economics api={isApi} demo={snapshot?.indicators} detailed={tab === 'economy'} revision={economyRevision} />
        </div>}
        {!information && <>
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
            <DataStatus api={isApi} snapshot={snapshot} pending={pending} error={error} />
          </section>
          <section className="panel settings-panel">
            <div className="panel-heading"><h2>관심종목 및 설정 저장</h2></div>
            <div className="setting"><strong>게스트 · 이 브라우저</strong><span>브라우저에 저장됨</span></div>
            <p className="storage-note">공유 기기에서는 같은 브라우저 프로필의 사용자가 저장된 목록을 볼 수 있습니다. 사이트 데이터를 지우면 저장값이 삭제됩니다.</p>
          </section>
          <Watchlist {...watchlistProps} chartPanel={favoriteChartPanel} />
        </>}
        </>}
        <footer>
          <span>Finance Dashboard</span>
          <nav className="footer-links" aria-label="서비스 정보">
            {Object.entries(informationPages).map(([id, label]) =>
              <a key={id} href={'#' + id} aria-current={tab === id ? 'page' : undefined}>{label}</a>)}
          </nav>
        </footer>
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
