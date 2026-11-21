import { lazy, Suspense, useEffect, useState } from 'react'
import { Activity, BarChart3, ChevronDown, CircleHelp, Globe2, Home, Landmark, Moon, RefreshCw, Settings, Sun, TrendingUp } from 'lucide-react'
import { dataMode, financeService } from './services/financeService'
import { Disclosures } from './components/Disclosures'
import { KoreaEconomy } from './components/KoreaEconomy'
import { DataStatus } from './components/DataStatus'
import { Economics } from './components/Economics'
import { informationPages, SiteInformation, type InformationPage } from './components/SiteInformation'
import { findMarketListing, parseStockPage } from './services/marketListings'
import { StockDetail } from './components/StockDetail'
import { MarketHeatmap } from './components/MarketHeatmap'
import { Watchlist } from './components/Watchlist'
import { Change, marketNames, price } from './components/QuoteDisplay'
import { guestStorage, type SettingsState } from './storage/guestStorage'
import { marketSymbolKey, type EquityMarket, type MarketSymbol } from './types/marketSymbol'
import type { FinanceSnapshot } from './types/finance'

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
type Page = Tab | InformationPage | `stock/${string}` | `index/${string}`

const marketIndices: readonly { id: string; name: string; market: EquityMarket }[] = [
  { id: 'kospi', name: 'KOSPI', market: 'KR' }, { id: 'kosdaq', name: 'KOSDAQ', market: 'KR' },
  { id: 'spx', name: 'S&P 500', market: 'US' }, { id: 'nasdaq', name: 'NASDAQ Composite', market: 'US' },
]
const indexPage = (path: string) => marketIndices.find(index => path === 'index/' + index.id)

const timestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
function hashPage(): Page | undefined {
  const hash = location.hash.slice(1)
  if (parseStockPage(hash)) return hash as `stock/${string}`
  if (indexPage(hash)) return hash as `index/${string}`
  if (Object.hasOwn(informationPages, hash)) return hash as InformationPage
  return tabs.find(item => item.id === hash)?.id
}
export function App() {
  const [settings, setSettings] = useState(guestStorage.loadSettings)
  const [tab, setTab] = useState<Page>(() => hashPage() ?? settings.market)
  const [watchlist, setWatchlist] = useState(() => guestStorage.favorites.load())
  const [storageFailures, setStorageFailures] = useState({ favorites: false, settings: false })
  const [snapshot, setSnapshot] = useState<FinanceSnapshot>()
  const [revision, setRevision] = useState(0)
  const [request, setRequest] = useState(0)
  const [dartRevision, setDartRevision] = useState(0)
  const [economyRevision, setEconomyRevision] = useState(0)
  const [pending, setPending] = useState(!isApi)
  const [error, setError] = useState(false)
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
    if (isApi) return
    let active = true
    financeService.getSnapshot().then(data => {
      if (!active) return
      setSnapshot(data)
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
    setWatchlist(previous => previous.some(item => marketSymbolKey(item) === key)
      ? previous.filter(item => marketSymbolKey(item) !== key)
      : [...previous, { market: symbol.market, exchange: symbol.exchange, symbol: symbol.symbol }])
  }

  const refresh = () => {
    if (!isApi) setPending(true)
    setError(false)
    setRequest(value => value + 1)
    if (tab === 'domestic') setDartRevision(value => value + 1)
    if (showEconomy) setEconomyRevision(value => value + 1)
  }

  const current = tabs.find(item => item.id === tab)
  const stock = parseStockPage(tab)
  const index = indexPage(tab)
  const information = Object.hasOwn(informationPages, tab) ? tab as InformationPage : undefined
  const pageLabel = stock ? (findMarketListing(stock)?.name ?? stock.symbol)
    : index?.name ?? current?.label ?? (information && informationPages[information])
  const market = tab === 'domestic' ? 'KR' : tab === 'global' ? 'US' : undefined
  const fx = snapshot?.quotes.find(quote => quote.kind === 'fx')
  const watchlistProps = { selected: watchlist, onToggle: toggle }
  const isMarket = tab === 'overview' || market !== undefined
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
      <div className="sidebar-footer"><CircleHelp size={16} aria-hidden="true" /> 시장 모니터링</div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <a className="compact-brand" href="#overview"><Activity size={20} aria-hidden="true" /> Finance Dashboard</a>
        <span className="breadcrumb">Finance Dashboard <span>/</span> {pageLabel}</span>
        {!information && !stock && !index && <div className="top-actions">
          <button className="icon-button" onClick={refresh} disabled={pending} aria-label="데이터 새로고침" title="데이터 새로고침"><RefreshCw size={17} /></button>
          <a className="icon-button" href="#settings" aria-label="설정" title="설정"><Settings size={18} /></a>
        </div>}
      </header>
      <div className="responsive-nav">{navigation}</div>
      <main>
        <div className="page-heading">
          <div><h1>{tab === 'overview' ? '시장 개요' : pageLabel}</h1></div>
        </div>
        {information ? <SiteInformation page={information} /> : stock ? <StockDetail listing={stock}
          saved={watchlist.some(item => marketSymbolKey(item) === marketSymbolKey(stock))} onToggle={() => toggle(stock)} />
          : index ? <section className="panel stock-detail" aria-label="지수 상세">
            <div className="section-heading"><h2>지수 추이</h2>
              <a href={index.market === 'KR' ? '#domestic' : '#global'}>시장으로 돌아가기</a>
            </div>
            <p className="state" role="status">실제 지수 시계열 데이터 미연결</p>
          </section> : <>
        {(storageFailures.favorites || storageFailures.settings) && <p className="notice" role="status">브라우저에 변경사항을 저장하지 못했습니다. 현재 화면에서만 유지됩니다.</p>}
        {pending && (!isApi || tab !== 'economy') && <p className={snapshot ? 'refresh-status' : 'panel state'} role="status">데이터를 불러오는 중입니다.</p>}
        {error && (!isApi || tab !== 'economy') && <div className="panel state"><p role="alert">{isApi ? 'API 데이터를 불러오지 못했습니다.' : '데이터 갱신에 실패했습니다.'}</p><button className="button" onClick={refresh}>다시 시도</button></div>}
        <Suspense fallback={<p className="panel state" role="status">차트를 준비하는 중입니다.</p>}>
        {isMarket && <>
          <section aria-label="핵심 지표">
            <div className="section-heading"><h2>핵심 지표</h2></div>
            <div className={market ? 'quote-grid' : 'quote-grid overview-quotes'}>
              {marketIndices.filter(index => !market || index.market === market).map(index =>
                <article className="panel quote-card" key={index.name}>
                  <div className="quote-label"><h3><a className="stock-detail-link" href={'#index/' + index.id}>{index.name}</a></h3><span>{marketNames[index.market]}</span></div>
                  <small>데이터 미연결</small>
                </article>)}
            </div>
            {tab === 'overview' && !isApi && <section className="panel fx-summary" aria-label="환율">
              <h2><Globe2 size={16} aria-hidden="true" /> USD/KRW · DEMO</h2>
              {fx ? <><strong>{price(fx, settings.units)}</strong><Change quote={fx} detailed />
                <time dateTime={fx.asOf} title="환율 기준 시각 (KST)">{timestamp.format(new Date(fx.asOf))}{fx.delayed && ' · 지연'}</time></>
                : <small>환율 데이터가 없습니다.</small>}
            </section>}
          </section>
          {market && <MarketHeatmap key={market} market={market} favorites={watchlist} />}
          <Watchlist key={'watchlist:' + tab} {...watchlistProps} market={market} />
        </>}
        {isApi && tab === 'overview' && <FxDashboard revision={request} />}
        {snapshot && tab === 'trends' && (isApi
          ? <p className="panel state" role="status">현재 API는 키워드 트렌드를 지원하지 않습니다.</p>
          : <HistoryChart simulated items={snapshot.trendTopics.map(name => ({ id: name, name }))} revision={revision} />)}
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
            <DataStatus api={isApi} />
          </section>
          <section className="panel settings-panel">
            <div className="panel-heading"><h2>관심종목 및 설정 저장</h2></div>
            <div className="setting"><strong>게스트 · 이 브라우저</strong><span>브라우저에 저장됨</span></div>
            <p className="storage-note">공유 기기에서는 같은 브라우저 프로필의 사용자가 저장된 목록을 볼 수 있습니다. 사이트 데이터를 지우면 저장값이 삭제됩니다.</p>
          </section>
          <Watchlist {...watchlistProps} />
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
