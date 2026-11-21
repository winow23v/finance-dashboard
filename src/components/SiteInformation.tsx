export const informationPages = {
  about: '서비스 소개',
  sources: '데이터 출처·이용안내',
  privacy: '개인정보처리방침',
  contact: '문의',
}

export type InformationPage = keyof typeof informationPages

function DataSources() {
  return <>
    <h2>날짜와 시각 읽는 법</h2>
    <dl className="source-timing">
      <div><dt>관측일·관측월</dt><dd>통계나 환율이 나타내는 날짜 또는 기간입니다.</dd></div>
      <div><dt>공표일</dt><dd>제공기관이 값을 발표한 날짜입니다. 확인된 경우에 표시합니다.</dd></div>
      <div><dt>수집 시각</dt><dd>대시보드 서버가 공급자에서 그 값을 가져온 시각입니다. 캐시된 응답은 원래 수집 시각을 유지합니다.</dd></div>
    </dl>
    <div className="source-list">
      <section>
        <h2>환율 · 유럽중앙은행 (ECB)</h2>
        <p><strong>정기 공표</strong> · ECB 영업일마다 공표하는 일별 기준환율을 Frankfurter v2에서 가져옵니다. ECB는 보통 중부유럽 시각 16시쯤 갱신하며 TARGET 휴무일에는 공표가 없습니다.</p>
        <p>교차환율은 같은 관측일의 ECB 값을 사용합니다. 화면은 선택에 따라 엔화 100엔 기준으로 환산합니다. 기준환율은 참고용이며 실시간 매매 호가로 사용할 수 없습니다.</p>
        <p><a href="https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html">ECB 기준환율</a> · <a href="https://frankfurter.dev/">Frankfurter v2</a></p>
      </section>
      <section>
        <h2>한국 경제지표 · 한국은행 ECOS</h2>
        <p><strong>정기 공표 통계</strong> · 한국은행 기준금리는 일별 관측값을, 국가데이터처 소비자물가지수와 실업률은 월별 관측값을 표시합니다. 기준금리 변경과 월별 통계 발표 일정은 각 기관을 따릅니다.</p>
        <p>차트는 공표 관측값을 표시합니다. CPI 전년 동월 대비는 비교할 관측값이 있을 때 표시합니다.</p>
        <p><a href="https://ecos.bok.or.kr/">한국은행 ECOS</a> · <a href="https://www.bok.or.kr/portal/singl/baseRate/list.do?menuNo=200656">한국은행 기준금리</a> · <a href="https://kosis.kr/">국가통계포털 KOSIS</a></p>
      </section>
      <section>
        <h2>기업 공시·재무 · OPEN DART와 SEC EDGAR</h2>
        <p><strong>공시 접수 기준</strong> · 금융감독원의 국내 기업 공시·재무정보와 미국 증권거래위원회의 EDGAR 자료를 기업 조회 시 요청합니다. 새 자료와 정정 내역은 각 기관의 공개 시점을 따릅니다.</p>
        <p>공시일과 회계기간을 구분해 읽고, 재무 수치와 정정 내용은 원문을 확인하세요. SEC 접근 제한은 조회 화면에 표시됩니다.</p>
        <p><a href="https://opendart.fss.or.kr/">금융감독원 OPEN DART</a> · <a href="https://www.sec.gov/search-filings">미국 SEC EDGAR</a></p>
      </section>
      <section>
        <h2>시장 가격과 등락</h2>
        <p><strong>데이터 미연결</strong> · 시장 지수와 개별 종목은 승인된 시세 공급자가 연결되면 표시합니다. 기존 샘플 시세는 공개 화면에서 제외했습니다.</p>
        <p><a href="https://github.com/winow23v/finance-dashboard">Finance Dashboard 프로젝트</a></p>
      </section>
      <section>
        <h2>미국 거시경제 지표 · FRED</h2>
        <p><strong>비공개 검증용</strong> · 세인트루이스 연방준비은행 FRED를 통해 원 제공기관의 지표를 확인하는 기능입니다. 지표별 공표 주기가 다르며 공개 대시보드에서는 실데이터를 제공하지 않습니다.</p>
        <p><a href="https://fred.stlouisfed.org/">FRED</a> · <a href="https://fred.stlouisfed.org/legal/">FRED 이용약관과 출처 안내</a></p>
      </section>
    </div>
  </>
}

export function SiteInformation({ page }: { page: InformationPage }) {
  return <section className="panel site-information">
    {page === 'about' && <>
      <p>Finance Dashboard는 국내외 증시와 환율, 경제지표, 기업 공시를 한 화면에서 살펴보는 공개 대시보드입니다. 누구나 로그인 없이 이용할 수 있습니다.</p>
      <p>종목을 검색해 관심종목에 저장하고 상세 화면에서 시세 연결 상태를 확인할 수 있습니다.</p>
    </>}
    {page === 'sources' && <DataSources />}
    {page === 'privacy' && <>
      <p>서비스는 계정을 만들거나 로그인을 요구하지 않습니다. 관심종목과 화면 설정은 브라우저의 localStorage에 저장됩니다. 해당 사이트의 브라우저 데이터를 지우면 삭제됩니다.</p>
      <p>API는 과도한 요청을 제한하기 위해 요청 IP를 메모리의 요청 카운터에 사용합니다. API 접속 정보는 서버 접근 로그에 기록될 수 있습니다.</p>
      <p>페이지는 GitHub Pages에서 제공됩니다. GitHub에서 처리하는 접속 정보는 <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">GitHub 개인정보처리방침</a>에서 확인할 수 있습니다.</p>
      <p>서비스에 현재 광고 스크립트가 연결되어 있지 않습니다.</p>
    </>}
    {page === 'contact' && <>
      <p>기능 문의와 오류 제보는 프로젝트의 <a href="https://github.com/winow23v/finance-dashboard/issues">GitHub Issues</a>에 남길 수 있습니다.</p>
      <p>이슈는 공개됩니다. 제보 내용에 개인정보, API 키 또는 비밀번호를 포함하지 마세요.</p>
    </>}
  </section>
}
