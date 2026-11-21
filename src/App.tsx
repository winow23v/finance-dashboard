import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Activity, BarChart3, ChevronDown, FileSearch, Globe2, Landmark, LayoutDashboard, Menu, Moon, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Settings, ShieldCheck, Star, Sun, TrendingUp, X } from 'lucide-react'
import { dataMode } from './services/financeService'
import { getKrxOverview, getMarketIndices } from './services/apiFinanceService'
import { mockFinanceService } from './mocks/mockFinance'
import type { MemberSession } from './services/membership'
import { MemberAdmin } from './components/MemberAdmin'
import { Disclosures } from './components/Disclosures'
import { KoreaEconomy } from './components/KoreaEconomy'
import { providerStatuses } from './services/providerStatus'
import { DataStatus } from './components/DataStatus'
import { Economics } from './components/Economics'
import { informationPages, SiteInformation, type InformationPage } from './components/SiteInformation'
import { findMarketListing, parseStockPage } from './services/marketListings'
import { StockDetail } from './components/StockDetail'
import { KrxStocks, krxStateLabels } from './components/KrxStocks'
import { KrxHeatmap, KrxMovers } from './components/KrxMarketOverview'
import { MarketHeatmap } from './components/MarketHeatmap'
import { Watchlist } from './components/Watchlist'
import { Change, marketNames, price } from './components/QuoteDisplay'
import { guestStorage, type SettingsState } from './storage/guestStorage'
import { marketSymbolKey, type EquityMarket, type MarketSymbol } from './types/marketSymbol'
import type { FinanceSnapshot, KrxOverview, MarketIndex } from './types/finance'

const FxDashboard = lazy(() => import('./components/FxDashboard'))
const HistoryChart = lazy(() => import('./components/HistoryChart'))
const isApi = dataMode === 'api'

const tabs = [
  { id: 'overview', label: '시장 개요', icon: LayoutDashboard },
  { id: 'domestic', label: '국내시장', icon: BarChart3 },
  { id: 'global', label: '해외시장', icon: Globe2 },
  { id: 'companies', label: '기업 검색·공시', icon: FileSearch },
  { id: 'economy', label: '환율·경제지표', icon: Landmark },
  { id: 'watchlist', label: '관심종목', icon: Star },
  { id: 'settings', label: '설정', icon: Settings },
] as const
const memberAdminTab = { id: 'members', label: '회원 승인 관리', icon: ShieldCheck } as const
const trends = { id: 'trends', label: '키워드 트렌드', icon: TrendingUp } as const
const mobileTabs = [
  { ...tabs[0], label: '개요' }, { ...tabs[1], label: '국내' },
  { ...tabs[2], label: '해외' }, { ...tabs[5], label: '관심' },
] as const
const refreshInterval = 30_000
const compactRailQuery = '(min-width: 781px) and (max-width: 1300px)'
const mobileQuery = '(max-width: 780px)'
type Tab = typeof tabs[number]['id']
type Page = Tab | 'members' | 'trends' | 'economy/fx-settings' | InformationPage | `stock/${string}` | `index/${string}`

const marketIndices: readonly { id: string; name: string; market: EquityMarket }[] = [
  { id: 'kospi', name: 'KOSPI', market: 'KR' }, { id: 'kosdaq', name: 'KOSDAQ', market: 'KR' },
  { id: 'spx', name: 'S&P 500', market: 'US' }, { id: 'nasdaq', name: 'NASDAQ Composite', market: 'US' },
]
const indexPage = (path: string) => marketIndices.find(index => path === 'index/' + index.id)

const timestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
const indexPrice = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const indexUnavailable = {
  'provider-not-configured': '지수 시세 공급자 미연결',
  'no-observation': '유효한 관측값 없음',
  'provider-error': '지수 공급자 조회 실패',
  'not-published': '기준일 자료 미확인',
  weekend: '주말 휴장',
  'before-collection': '당일 수집 대기',
}

function MarketIndexValue({ quote, failed }: { quote?: MarketIndex; failed: boolean }) {
  if (failed) return <small role="status">시장지수 API 조회 실패</small>
  if (!quote) return <small role="status">지수 시세를 불러오는 중입니다.</small>
  if (quote.status === 'unavailable') return <small>{indexUnavailable[quote.reason]}</small>
  return <>
    <strong>{indexPrice.format(quote.price)}</strong>
    {quote.change !== null && quote.changePercent !== null && <Change quote={{ change: quote.change, percent: quote.changePercent }} detailed />}
    <small className="index-source"><time dateTime={quote.tradingDate}>{quote.tradingDate}</time> 거래 종가
      {quote.reason ? ' · ' + krxStateLabels[quote.reason] : quote.status === 'stale' ? ' · 갱신 지연' : ''}
      {quote.reason === 'provider-error' && ' (마지막 유효값)'}</small>
    <details className="index-metadata">
      <summary>출처·수집 시각</summary>
      <small>{quote.source}</small>
      {quote.observedAt.includes('T') && <small>관측 <time dateTime={quote.observedAt}>{timestamp.format(new Date(quote.observedAt))}</time> (KST)</small>}
      <small>수집 <time dateTime={quote.collectedAt}>{timestamp.format(new Date(quote.collectedAt))}</time> (KST)</small>
    </details>
  </>
}
function hashPage(): Page | undefined {
  const hash = location.hash.slice(1)
  if (hash === 'companies/us') return 'global'
  if (parseStockPage(hash)) return hash as `stock/${string}`
  if (indexPage(hash)) return hash as `index/${string}`
  if (Object.hasOwn(informationPages, hash)) return hash as InformationPage
  if (hash === 'members' || hash === 'trends' || hash === 'economy/fx-settings') return hash
  return tabs.find(item => item.id === hash)?.id
}
export function App({ member, signOut, accountBusy, accountError }: {
  member?: MemberSession; signOut?: () => void; accountBusy?: boolean; accountError?: string
} = {}) {
  const [settings, setSettings] = useState(guestStorage.loadSettings)
  const [tab, setTab] = useState<Page>(() => hashPage() ?? settings.market)
  const [watchlist, setWatchlist] = useState(() => guestStorage.favorites.load())
  const [storageFailures, setStorageFailures] = useState({ favorites: false, settings: false })
  const [snapshot, setSnapshot] = useState<FinanceSnapshot>()
  const [indexResult, setIndexResult] = useState<{ request: number; quotes: MarketIndex[] | null }>()
  const [krxResult, setKrxResult] = useState<{ request: number; data: KrxOverview | null }>()
  const [revision, setRevision] = useState(0)
  const [request, setRequest] = useState(0)
  const [dartRevision, setDartRevision] = useState(0)
  const [searchFocus, setSearchFocus] = useState(0)
  const [dartReady, setDartReady] = useState(false)
  const [fxReady, setFxReady] = useState(false)
  const [ecosReady, setEcosReady] = useState(false)
  const [fredReady, setFredReady] = useState(false)
  const [compactRail, setCompactRail] = useState(() => matchMedia(compactRailQuery).matches)
  const [railOverride, setRailOverride] = useState<boolean>()
  const [menuOpen, setMenuOpen] = useState(false)
  const collapsed = railOverride ?? compactRail
  const [refreshUntil, setRefreshUntil] = useState(0)
  const refreshLock = useRef(0)
  const menuDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const compact = matchMedia(compactRailQuery)
    const mobile = matchMedia(mobileQuery)
    const updateRail = () => setCompactRail(compact.matches)
    const closeMenu = () => { if (!mobile.matches) menuDialog.current?.close() }
    compact.addEventListener('change', updateRail)
    mobile.addEventListener('change', closeMenu)
    return () => {
      compact.removeEventListener('change', updateRail)
      mobile.removeEventListener('change', closeMenu)
    }
  }, [])
  const statuses = useSyncExternalStore(providerStatuses.subscribe, providerStatuses.read)
  const [economyRevision, setEconomyRevision] = useState(0)
  const [pending, setPending] = useState(!isApi)
  const [error, setError] = useState(false)
  const economyPage = tab === 'economy' || tab === 'economy/fx-settings'
  const showEconomy = tab === 'overview' || economyPage
  const companyPage = tab === 'companies'
  const market = tab === 'domestic' ? 'KR' : tab === 'global' ? 'US' : undefined
  const isMarket = tab === 'overview' || market !== undefined
  const marketResult = indexResult?.request === request ? indexResult : undefined
  const showKrxOverview = isMarket && market !== 'US'
  const krxOverview = krxResult?.request === request ? krxResult.data : undefined
  const section = economyPage ? 'economy' : tab
  const providerValues = Object.values(statuses)
  const dataLabel = !isApi ? 'DEMO 모드' : !providerValues.length ? '연결 확인되지 않음'
    : providerValues.every(status => status === 'published') ? '공표 데이터 확인'
      : providerValues.some(status => status === 'published' || status === 'previous' || status === 'partial')
        ? '공급자별 상태 확인' : '조회 상태 확인 필요'

  useEffect(() => {
    if (!refreshUntil) return
    const timer = window.setTimeout(() => setRefreshUntil(0), Math.max(0, refreshUntil - Date.now()))
    return () => window.clearTimeout(timer)
  }, [refreshUntil])
  const [visitedEconomy, setVisitedEconomy] = useState(showEconomy)

  useEffect(() => {
    if (showEconomy) setVisitedEconomy(true)
  }, [showEconomy])
  useEffect(() => {
    const change = () => {
      setTab(hashPage() ?? guestStorage.loadSettings().market)
      window.scrollTo(0, 0)
    }
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
    mockFinanceService.getSnapshot().then(data => {
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
  useEffect(() => {
    if (!isApi || !isMarket) return
    const controller = new AbortController()
    const finish = (quotes: MarketIndex[] | null) => {
      if (!controller.signal.aborted) setIndexResult({ request, quotes })
    }
    void getMarketIndices(controller.signal).then(finish, () => finish(null))
    return () => controller.abort()
  }, [isMarket, request])
  useEffect(() => {
    if (!isApi || !showKrxOverview) return
    const controller = new AbortController()
    const finish = (data: KrxOverview | null) => {
      if (!controller.signal.aborted) setKrxResult({ request, data })
    }
    void getKrxOverview(controller.signal).then(finish, () => finish(null))
    return () => controller.abort()
  }, [showKrxOverview, request])

  const toggle = (symbol: MarketSymbol) => {
    const key = marketSymbolKey(symbol)
    setWatchlist(previous => previous.some(item => marketSymbolKey(item) === key)
      ? previous.filter(item => marketSymbolKey(item) !== key)
      : [...previous, { market: symbol.market, exchange: symbol.exchange, symbol: symbol.symbol }])
  }

  const canRefresh = isApi ? isMarket || showEconomy || companyPage : showEconomy || tab === 'trends'
  const refreshing = pending || (isApi && ((isMarket && !marketResult) || (showEconomy && !(fxReady && ecosReady && fredReady))))
  const refreshDisabled = !canRefresh || refreshing || !!refreshUntil || (tab === 'companies' && !dartReady)
  const refresh = () => {
    if (refreshDisabled || Date.now() < refreshLock.current) return
    refreshLock.current = Date.now() + refreshInterval
    setRefreshUntil(refreshLock.current)
    setError(false)
    if (!isApi) {
      setPending(true)
      setRequest(value => value + 1)
    }
    if (isApi && isMarket) setRequest(value => value + 1)
    if (tab === 'companies') setDartRevision(value => value + 1)
    if (showEconomy) setEconomyRevision(value => value + 1)
  }

  const current = [...tabs, trends].find(item => item.id === section)
  const stock = parseStockPage(tab)
  const index = indexPage(tab)
  const detailMarket = stock?.market ?? index?.market
  const navSection = detailMarket ? (detailMarket === 'KR' ? 'domestic' : 'global') : section
  const information = Object.hasOwn(informationPages, tab) ? tab as InformationPage : undefined
  const pageLabel = stock ? (findMarketListing(stock)?.name ?? stock.symbol)
    : tab === 'members' ? '회원 승인 관리' : index?.name ?? current?.label ?? (information && informationPages[information])
  const fx = snapshot?.quotes.find(quote => quote.kind === 'fx')
  const watchlistProps = { selected: watchlist, onToggle: toggle }
  const navigationLinks = (items: readonly (typeof tabs[number] | typeof trends | typeof memberAdminTab | typeof mobileTabs[number])[]) =>
    items.map(({ id, label, icon: Icon }) => <a key={id} href={'#' + id} title={label} aria-label={label}
      aria-current={id === navSection ? (id === section ? 'page' : 'location') : undefined}>
      <Icon size={19} aria-hidden="true" /><span>{label}</span>
    </a>)
  const themeLabel = settings.theme === 'dark' ? '라이트 테마로 전환' : '다크 테마로 전환'
  const refreshLabel = refreshing || refreshUntil ? '데이터 새로고침 대기 중'
    : refreshDisabled ? '새로고침할 데이터 없음' : '데이터 새로고침'
  const RailIcon = collapsed ? PanelLeftOpen : PanelLeftClose

  return <div className={collapsed ? 'app rail-collapsed' : 'app'}>
    <a className="skip-link" href="#main-content" onClick={event => {
      event.preventDefault()
      document.getElementById('main-content')?.focus()
    }}>본문으로 이동</a>
    <header className="topbar">
      <a className="brand" href="#overview" aria-label="Finance Dashboard">
        <span className="brand-icon"><Activity size={19} aria-hidden="true" /></span>
        <span className="brand-name">Finance Dashboard<small>{dataLabel}</small></span>
      </a>
      <span className="breadcrumb">워크스페이스 <span aria-hidden="true">/</span> <strong>{pageLabel}</strong></span>
      <div className="top-actions">
        <a className="connection-status" href="#settings" title="공급자별 데이터 상태"><i aria-hidden="true" />{dataLabel}</a>
        <a className="icon-button" href="#companies" aria-label="통합 종목·기업 검색" title="통합 종목·기업 검색"
          onClick={() => setSearchFocus(value => value + 1)}><Search size={18} /></a>
        <button className="icon-button" onClick={refresh} disabled={refreshDisabled}
          aria-label={refreshLabel} title={refreshLabel}><RefreshCw size={17} /></button>
        <button className="icon-button" aria-label={themeLabel} title={themeLabel}
          onClick={() => setSettings(previous => ({ ...previous, theme: previous.theme === 'dark' ? 'light' : 'dark' }))}>
          {settings.theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <a className="icon-button" href="#settings" aria-label="설정" title="설정"><Settings size={18} /></a>
      </div>
    </header>
    <aside className="sidebar">
      <button className="rail-toggle" type="button" aria-expanded={!collapsed} aria-controls="desktop-navigation"
        aria-label={collapsed ? '메뉴 펼치기' : '메뉴 접기'} title={collapsed ? '메뉴 펼치기' : '메뉴 접기'}
        onClick={() => setRailOverride(!collapsed)}><RailIcon size={18} aria-hidden="true" />
        <span>{collapsed ? '메뉴 펼치기' : '메뉴 접기'}</span></button>
      <nav className="side-navigation" id="desktop-navigation" aria-label="주 메뉴">{navigationLinks(member?.admin ? [...tabs, memberAdminTab] : tabs)}</nav>
      {(!isApi || tab === 'trends') && <nav className="side-navigation" aria-label="추가 메뉴">{navigationLinks([trends])}</nav>}
    </aside>
    <div className="workspace">
      <main id="main-content" tabIndex={-1}>
        <div className="page-heading">
          <h1>{pageLabel}</h1>
        </div>
        {information ? <SiteInformation page={information} /> : stock ?
          <StockDetail listing={stock} saved={watchlist.some(item => marketSymbolKey(item) === marketSymbolKey(stock))}
            onToggle={() => toggle(stock)} liveQuote={isApi && stock.market === 'KR' && stock.exchange === 'XKRX'} />
          : index ? <section className="panel stock-detail" aria-label="지수 상세">
            <div className="section-heading"><h2>지수 추이</h2>
              <a href={index.market === 'KR' ? '#domestic' : '#global'}>시장으로 돌아가기</a>
            </div>
            <p className="state" role="status">지수 시계열 공급자 미연결</p>
          </section> : <>
        {(storageFailures.favorites || storageFailures.settings) && <p className="notice" role="status">브라우저에 변경사항을 저장하지 못했습니다. 현재 화면에서만 유지됩니다.</p>}
        {pending && (!isApi || !economyPage) && <p className={snapshot ? 'refresh-status' : 'panel state'} role="status">데이터를 불러오는 중입니다.</p>}
        {error && (!isApi || !economyPage) && <div className="panel state"><p role="alert">{isApi ? 'API 데이터를 불러오지 못했습니다.' : '데이터 갱신에 실패했습니다.'}</p><button className="button" onClick={refresh} disabled={!!refreshUntil}>다시 시도</button></div>}
        <Suspense fallback={<p className="panel state" role="status">차트를 준비하는 중입니다.</p>}>
        {isMarket && <>
          <section aria-label="핵심 시장지수">
            <div className="section-heading"><h2>핵심 시장지수</h2></div>
            <div className={market ? 'quote-grid market-index-quotes' : 'quote-grid market-index-quotes overview-quotes'}>
              {marketIndices.filter(index => !market || index.market === market).map(index =>
                <article className="panel quote-card" key={index.name}>
                  <div className="quote-label"><h3><a className="stock-detail-link" href={'#index/' + index.id}>{index.name}</a></h3><span>{marketNames[index.market]}</span></div>
                  {isApi && marketResult?.quotes && !marketResult.quotes.some(quote => quote.id === index.id)
                    ? <small>지수 응답 없음</small>
                    : isApi ? <MarketIndexValue quote={marketResult?.quotes?.find(quote => quote.id === index.id)}
                      failed={marketResult?.quotes === null} /> : <small>지수 시세 공급자 미연결</small>}
                </article>)}
            </div>
          </section>
          {tab === 'overview' && <KrxMovers data={isApi ? krxOverview : null} />}
          <div className={market === 'US' ? 'market-sections overseas-panels' : 'market-sections'}>
            {(!market || market === 'KR') && (isApi ? <KrxHeatmap data={krxOverview} summary={!market} />
              : <MarketHeatmap market="KR" favorites={watchlist} summary={!market} />)}
            {(!market || market === 'US') && <MarketHeatmap market="US" favorites={watchlist} summary={!market} />}
            {market === 'US' && <Watchlist key={'watchlist:' + tab} {...watchlistProps} market={market} />}
          </div>
          {isApi && market !== 'US' && <KrxStocks {...watchlistProps} />}
          {market !== 'US' && <Watchlist key={'watchlist:' + tab} {...watchlistProps} market={market} />}
          {market === 'KR' && <a className="text-link" href="#companies">기업 검색·공시 보기</a>}
        </>}
        {tab === 'watchlist' && <Watchlist {...watchlistProps} />}
        {companyPage && !isApi && <p className="panel state">기업 공시 공급자 미연결</p>}
        {companyPage && <a className="text-link" href="#watchlist">관심종목에서 국내외 종목 검색</a>}
        {tab === 'overview' && !isApi && <section className="panel fx-summary" aria-label="환율">
          <h2><Globe2 size={16} aria-hidden="true" /> USD/KRW · DEMO</h2>
          {fx ? <><strong>{price(fx, settings.units)}</strong><Change quote={fx} detailed />
            <time dateTime={fx.asOf} title="환율 기준 시각 (KST)">{timestamp.format(new Date(fx.asOf))}{fx.delayed && ' · 지연'}</time></>
            : <small>환율 데이터가 없습니다.</small>}
        </section>}
        {tab === 'trends' && isApi && <p className="panel state">현재 API는 키워드 트렌드를 지원하지 않습니다.</p>}
        {snapshot && tab === 'trends' && <HistoryChart simulated items={snapshot.trendTopics.map(name => ({ id: name, name }))} revision={revision} />}
        </Suspense>
        </>}
        {isApi && <div hidden={tab !== 'companies'}><Disclosures revision={dartRevision} visible={tab === 'companies'} searchFocus={searchFocus} onRefreshReady={setDartReady} /></div>}
        {(showEconomy || visitedEconomy) && (isApi || snapshot) && <div className="economy-stack" hidden={!showEconomy}>
          {tab === 'overview' && <div className="section-heading economy-summary-heading">
            <h2>환율·경제지표 요약</h2><a className="text-link" href="#economy">상세보기</a>
          </div>}
          {isApi && <Suspense fallback={<p className="panel state" role="status">환율을 준비하는 중입니다.</p>}>
            <FxDashboard revision={economyRevision} detailed={economyPage} onRefreshReady={setFxReady} showSettings={tab === 'economy/fx-settings'} />
          </Suspense>}
          {isApi && <KoreaEconomy revision={economyRevision} visible={economyPage} onRefreshReady={setEcosReady} />}
          <Economics api={isApi} demo={snapshot?.indicators} detailed={economyPage} revision={economyRevision} onRefreshReady={setFredReady} />
        </div>}
        {tab === 'members' && (member?.admin ? <MemberAdmin userId={member.userId} />
          : <p className="panel state">관리자 전용 화면입니다.</p>)}
        {tab === 'settings' && <>
          {member && <section className="panel member-panel">
            <h2>회원 계정</h2>
            <p>{member.email} · 승인됨</p>
            <div className="member-actions">
              {member.admin && <a className="button" href="#members">회원 승인 관리</a>}
              <button className="button" disabled={accountBusy} onClick={signOut}>로그아웃</button>
            </div>
            {accountError && <p className="notice" role="alert">{accountError}</p>}
          </section>}
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
            {isApi && <div className="setting"><strong>환율 설정</strong><a href="#economy/fx-settings" className="button">환율 설정 열기</a></div>}
          </section>
          <section className="panel settings-panel">
            <DataStatus api={isApi} />
          </section>
          <section className="panel settings-panel">
            <div className="panel-heading"><h2>관심종목 및 설정 저장</h2></div>
            <div className="setting"><strong>게스트 · 이 브라우저</strong><span>브라우저에 저장됨</span></div>
            <p className="storage-note">공유 기기에서는 같은 브라우저 프로필의 사용자가 저장된 목록을 볼 수 있습니다. 사이트 데이터를 지우면 저장값이 삭제됩니다.</p>
          </section>
          <Watchlist {...watchlistProps} />
        </>}
      </main>
      <footer className="app-footer">
        <div className="footer-top">
          <strong>Finance Dashboard</strong>
          <nav className="footer-links" aria-label="서비스 정보">
            {Object.entries(informationPages).map(([id, label]) =>
              <a key={id} href={'#' + id} aria-current={tab === id ? 'page' : undefined}>{label}</a>)}
          </nav>
        </div>
        <p>금융 데이터는 공급자에 따라 지연될 수 있으며 정확성과 완전성을 보장하지 않습니다. 투자 참고용 정보이며 투자 권유가 아닙니다.</p>
        <small>© Finance Dashboard</small>
      </footer>
    </div>
    <nav className="mobile-navigation" aria-label="모바일 주 메뉴">
      {navigationLinks(mobileTabs)}
      <button type="button" aria-haspopup="dialog" aria-controls="mobile-menu" aria-expanded={menuOpen}
        className={mobileTabs.some(item => item.id === navSection) ? undefined : 'mobile-menu-active'}
        onClick={() => {
          menuDialog.current?.showModal()
          setMenuOpen(true)
        }}><Menu size={19} aria-hidden="true" /><span>전체</span></button>
    </nav>
    <dialog id="mobile-menu" ref={menuDialog} aria-labelledby="mobile-menu-title" onClose={() => setMenuOpen(false)} onClick={event => {
      if ((event.target as HTMLElement).closest('a')) menuDialog.current?.close()
    }}>
      <div className="panel-heading"><h2 id="mobile-menu-title">전체 메뉴</h2>
        <button type="button" className="icon-button" aria-label="닫기" title="닫기"
          onClick={() => menuDialog.current?.close()}><X size={18} /></button>
      </div>
      <nav className="side-navigation" aria-label="전체 메뉴">{navigationLinks(member?.admin ? [...tabs, memberAdminTab] : isApi ? tabs : [...tabs, trends])}</nav>
    </dialog>
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
