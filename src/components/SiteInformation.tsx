export const informationPages = {
  about: '서비스 소개',
  sources: '데이터 출처',
  privacy: '개인정보처리방침',
  contact: '문의',
}

export type InformationPage = keyof typeof informationPages

export function SiteInformation({ page }: { page: InformationPage }) {
  return <section className="panel site-information">
    {page === 'about' && <>
      <p>Finance Dashboard는 국내외 증시와 환율, 미국 경제지표를 한 화면에서 살펴보는 공개 대시보드입니다. 누구나 로그인 없이 이용할 수 있습니다.</p>
      <p>관심종목을 저장하고 지수의 기간별 흐름을 살펴볼 수 있습니다. DEMO로 표시된 수치는 화면과 기능을 보여 주는 예시입니다.</p>
    </>}
    {page === 'sources' && <>
      <p>공개 시장 데이터의 DEMO 표시는 모의 가격과 차트를 뜻합니다. 화면에 표시된 기준 시각은 해당 데이터의 기준 시각입니다.</p>
      <p>개인 검증 환경의 FRED 실데이터에는 원 제공기관과 실제 관측일이 함께 표시됩니다.</p>
    </>}
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
