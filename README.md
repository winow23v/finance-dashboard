# Finance Dashboard

개인용 금융시장 모니터링 대시보드입니다. 개요, 국내시장, 해외시장, 경제지표, 키워드 트렌드, 설정 화면을 제공합니다. 현재 모든 금융 수치와 시장 상태는 DEMO 샘플입니다.

## 로컬 개발

Node.js 26과 npm이 필요합니다. 프로젝트는 Node.js 26.13.1과 npm 11.20.0 환경에서 구성했습니다.

```sh
npm ci
npm run dev
```

기본 주소는 `http://localhost:5173/finance-dashboard/`입니다. 포트 충돌 시 Vite가 터미널에 표시하는 주소를 사용하세요. 기본 Mock 모드는 API 키와 백엔드 없이 실행됩니다. 관심종목과 표시 설정은 현재 브라우저의 localStorage에 저장됩니다.

```sh
npm run typecheck
npm run build
npm run preview
```

## 프로젝트 구조

| 경로 | 역할 |
| --- | --- |
| `src/App.tsx` | 해시 탐색, 화면 레이아웃, 데이터 상태, 관심종목 및 설정 |
| `src/components/HistoryChart.tsx` | 시계열 차트, 기간 선택, 키워드 두 개 비교 |
| `src/components/Watchlist.tsx` | 관심종목 및 종목 목록, 별표 토글과 검색 |
| `src/types/marketSymbol.ts` | 시장, 거래소, 종목코드로 구성된 종목 식별자 |
| `src/storage/` | 게스트 저장소, 관심종목 병합 및 클라우드 저장소 계약 |
| `src/types/finance.ts` | 시세, 시장 상태, 경제지표, 시계열 계약 |
| `src/services/financeService.ts` | 모든 금융 데이터 조회의 진입점 |
| `src/services/apiFinanceService.ts` | Fastify 요청과 응답 검증 |
| `src/mocks/mockFinance.ts` | 샘플 스냅샷과 시계열 생성 |
| `src/styles.css` | Tailwind CSS 및 반응형 테마 |
| `.github/workflows/pages.yml` | 검증, 빌드, GitHub Pages 배포 |

## Fastify API 연결

`VITE_DATA_MODE=mock`은 샘플 공급자를 선택하며 값을 생략해도 동일합니다. Oracle API를 개발 환경에서 확인하려면 SSH 터널을 열고 다음 명령을 실행합니다.

```sh
VITE_DATA_MODE=api npm run dev
```

앱은 `/finance-dashboard/`에서 열고, 브라우저의 `/api/` 요청은 Vite 개발 서버가 `http://192.168.0.68:8088`로 전달합니다. 터널 재연결 방법은 [DEPLOYMENT.md](DEPLOYMENT.md)에 있습니다.

API 모드는 시장 스냅샷과 지수 히스토리를 조회합니다. 현재 Oracle 응답의 `source.simulated: true`를 사용해 DEMO 표시를 유지합니다. 개별 주식·ETF 시세, 경제지표, 키워드 트렌드의 제공 여부는 화면에 표시되며, 저장된 관심종목은 시세 없이도 확인하거나 삭제할 수 있습니다. API 오류는 화면에서 재시도할 수 있습니다.

GitHub Pages는 `VITE_DATA_MODE=mock`으로 빌드합니다. 향후 공개 API를 사용할 때는 빌드 환경에 `VITE_DATA_MODE=api`와 `VITE_API_BASE_URL=https://api.example.com`을 설정하고 API에서 GitHub Pages 출처(`https://winow23v.github.io`)를 CORS로 허용합니다. `VITE_*` 값은 빌드에 포함되므로 공개 설정만 넣고 API 비밀키는 서버에 보관합니다. 환경변수를 바꾼 뒤에는 개발 서버를 재시작하거나 운영 번들을 재빌드하고 배포해야 합니다.

공급자 선택은 `financeService.ts`에 모여 있습니다. API 전환을 완료하면 이 파일에서 Mock import와 선택 분기를 제거하고 `src/mocks/`를 삭제할 수 있습니다. 관심종목은 시세의 내부 `id`와 독립적인 `MarketSymbol`로 저장됩니다. 실제 API에서도 시장 코드, 거래소 MIC, 종목코드를 동일하게 정규화하세요. 시세 기준 시각과 경제지표 수집 시각은 시간대가 포함된 ISO 문자열로 전달하고 관측일과 발표일은 날짜 문자열로 유지합니다.

## 비로그인 저장

관심종목과 표시 설정은 각각 `finance.watchlist`, `finance.settings`에 `{ version: 1, data }` 형태로 저장됩니다. 기존 종목 ID 배열과 설정 객체는 처음 로드할 때 변환됩니다. 예전 샘플 추천 목록은 브라우저에 직접 저장된 항목만 이어집니다.

저장 범위는 브라우저 프로필과 사이트 출처입니다. 공유 프로필을 쓰는 사람이나 동일 출처에서 실행되는 스크립트가 값을 읽을 수 있고, 사이트 데이터를 지우면 저장값이 삭제됩니다. 앱은 관심종목 식별자와 표시 설정만 이 저장소에 기록합니다. 저장이 차단된 환경에서는 현재 페이지에서 사용할 수 있고 저장 실패가 표시됩니다.

## Supabase 로그인과 동기화 연결

현재 앱은 게스트 저장소로 실행됩니다. `CloudFavoriteRepository`는 인증 세션을 요구하는 미구현 어댑터이며 조회와 저장 모두 오류로 종료됩니다. 설정 화면은 계정 동기화가 준비 중임을 표시합니다.

1. Supabase Auth의 확인된 세션이 있을 때만 사용자별 클라우드 어댑터를 엽니다. 로그아웃이나 계정 전환 시 진행 중인 요청과 구독을 취소하고 이전 사용자 ID의 메모리 캐시를 비운 뒤 게스트 저장소를 로드합니다. 다른 계정의 목록을 게스트 저장소로 복사하지 않습니다.
2. PostgreSQL 관심종목 테이블에 `user_id, market, exchange, symbol` 복합 고유 제약을 추가합니다. 각 연산에 RLS를 적용하고 `auth.uid()`로 소유권을 검증합니다. Fastify를 경유한다면 서버에서 서명된 세션 토큰을 검증하고 사용자 ID를 세션에서 구합니다.
3. 로그인 시 클라우드 목록을 읽고 `mergeFavorites`로 로컬 목록을 합칩니다. DB에서는 새 항목을 중복 없이 삽입하고 저장 확인 뒤에만 계정 세션에 병합 완료를 표시합니다. 동일 게스트 목록을 다시 로그인할 때 삭제한 종목이 되살아나지 않도록 사용자별 가져오기 완료를 서버에 기록합니다. 실패하면 게스트 목록을 보존해 재시도합니다.
4. 로그인 이후의 변경은 해당 종목만 삽입하거나 삭제하고 서버 응답으로 화면 캐시를 맞춥니다. 다른 기기는 로그인 또는 포커스 복귀 시 다시 조회하거나 세션 범위의 Realtime 구독을 사용합니다. 전체 목록 교체가 필요하면 버전 검사나 트랜잭션을 적용해 동시 변경 유실을 막습니다.

## GitHub Pages

1. 사용할 GitHub 저장소를 준비한 뒤 코드를 `main` 또는 `master`에 푸시합니다.
2. 저장소 **Settings → Pages → Build and deployment → Source**에서 **GitHub Actions**를 선택합니다.
3. 워크플로가 실행되지 않았다면 **Actions → GitHub Pages → Run workflow**에서 실행합니다.

워크플로는 `npm ci`, `npm run typecheck`, `npm run build`를 실행한 뒤 `dist/`를 배포합니다. GitHub Pages가 제공하는 base 경로를 빌드에 전달하므로 저장소 이름이 다르거나 루트에 배포할 때도 자산 링크가 맞습니다. 로컬 기본 base는 `/finance-dashboard/`이며, 별도 환경에서는 `PAGES_BASE_PATH`로 바꿀 수 있습니다. 화면 주소에는 `#domestic`과 같은 해시를 사용하므로 새로고침해도 호스트는 같은 `index.html`을 제공합니다.
