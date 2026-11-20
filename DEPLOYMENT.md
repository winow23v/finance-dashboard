# Oracle VPS test deployment

- Browser: http://192.168.0.68:8088/finance-dashboard/
- Health: http://192.168.0.68:8088/health
- Snapshot: http://192.168.0.68:8088/api/v1/market/snapshot

The Steam Deck must be awake and on the same LAN as the browser device.
The browser connects to the Steam Deck, which forwards requests over SSH to Oracle.
Oracle nginx listens on 127.0.0.1:8080 for this tunnel.
The API listens on 127.0.0.1:3000 and runs as finance-dashboard-api.service.
API runtime: /opt/finance-dashboard/vps-api
Original deployment copies: /home/rocky/apps/finance-dashboard/
Web files: /var/www/finance-dashboard/
Nginx configuration: /etc/nginx/conf.d/finance-dashboard.conf

## Reconnect

On the Steam Deck, launch the desktop shortcut "Finance Dashboard", or run:

    ~/.local/bin/finance-dashboard-connect --no-open

Inside codex-dev Ubuntu, run:

    distrobox-host-exec /home/deck/.local/bin/finance-dashboard-connect --no-open

If the prior SSH session has ended, the Oracle SSH key passphrase is requested.
The LAN IP can change when Wi-Fi or DHCP changes.

## Current limitations

The Vite development server can proxy snapshot and index history requests through the SSH tunnel. Run `VITE_DATA_MODE=api npm run dev` from the frontend project.
GitHub Pages builds in API mode and sends browser requests to `https://winow.duckdns.org`. The public API must allow the `https://winow23v.github.io` origin for both snapshot and history. See [README.md](README.md) for the build settings.
Public market data is DEMO. FRED observations are available in private mode only. Supabase login/sync is not implemented.

## Fastify API 안정화

- Snapshot과 History는 IP당 60초에 합산 60회, Health는 별도 카운터로 120회까지 허용한다. 초과 응답은 HTTP 429와 대기 시간을 초 단위로 담은 `Retry-After`를 반환한다. 공개 API에는 인증이 없다. CORS는 브라우저 접근 정책이며, 공유 NAT의 사용자들은 한도를 공유한다. 카운터는 인스턴스별 메모리에 저장되며 재시작 또는 5,000개 키의 LRU에서 퇴출되면 초기화된다.
- Snapshot TTL은 30초, History TTL은 5분이다. 본문 형식은 기존과 동일하며 `X-Market-As-Of`는 공급자 데이터 기준시각, `X-Cache-Stored-At`은 서버가 결과를 저장한 시각이다. 데이터 기준시각이 Snapshot은 15분, History는 24시간 이상 지나면 `X-Market-Stale: true`를 반환한다. TTL이 지나면 결과를 다시 불러오고 공급자 장애는 오류로 응답한다. DEMO의 시각과 가격은 고정되어 있다. 브라우저 JavaScript에서 이 응답 헤더를 읽는 기능을 추가할 경우 기존 Nginx CORS 설정의 `Access-Control-Expose-Headers`에 필요한 헤더를 포함한다.
- 캐시는 직렬화된 본문 합계 2 MiB와 최대 128개 항목으로 제한한다. 항목마다 최대 256 KiB이며 메타데이터와 Node 프로세스 자체 메모리는 별도다. 같은 키의 요청은 공급자 호출을 공유하며, 동시 갱신 키는 최대 16개다. 응답을 검증하거나 처리할 수 없으면 502, 시간 초과 또는 동시 갱신 한도 도달 시 503을 반환한다.
- 실제 공급자를 연동할 때 어댑터는 `{ data, asOf }`로 정규화하고 기존 응답 스키마를 검증한다. 전달받은 `AbortSignal`을 HTTP 요청과 본문 읽기에 사용하고 외부 응답 크기를 읽는 동안 제한한다. 서버의 갱신 제한 시간은 5초다. 실제 API 키는 Oracle systemd 서비스의 환경변수로 주입한다. 환경 파일을 사용하는 경우 소유자를 root로 두고 권한을 0600으로 제한한다. Git, GitHub Pages 빌드, `VITE_*` 변수, URL 쿼리 및 로그에 키나 토큰을 넣지 않는다.

## Oracle 배포 전 점검

아래 명령은 운영 배포를 결정한 뒤 실행한다. 먼저 Oracle의 활성 설정을 읽기 전용으로 확인한다.

```sh
ssh oracle 'sudo nginx -t && sudo nginx -T'
ssh oracle 'sudo systemctl show finance-dashboard-api.service -p User -p WorkingDirectory -p ExecStart'
```

HTTPS와 터널의 API location이 모두 `http://127.0.0.1:3000`으로 연결되는지 확인한다. Fastify는 TCP 연결의 상대가 `127.0.0.1`일 때 `X-Forwarded-For`의 가장 오른쪽 주소만 사용한다. 각 location에서 Nginx가 `proxy_set_header X-Forwarded-For $remote_addr;`로 덮어쓰거나 `$proxy_add_x_forwarded_for`로 실제 연결 상대를 맨 오른쪽에 추가해야 한다. 클라이언트 헤더를 그대로 전달하거나, 신뢰되지 않은 연결에 대한 `real_ip` 재작성이 설정되어 있으면 배포를 보류한다. Oracle의 3000 포트는 루프백에만 바인딩하며, 기존 HTTPS, Certbot 및 Nginx의 CORS 헤더 설정을 그대로 사용한다. Fastify는 CORS 헤더를 추가하지 않는다.

## Oracle 배포 명령

저장소 루트에서 파일을 새 임시 디렉터리로 전송한다. Oracle의 `node` 및 `npm`은 서비스와 호환되는 버전을 사용한다.

```sh
set -eu
stage=$(ssh oracle 'mktemp -d /tmp/finance-api.XXXXXXXX')
scp vps-api/{server.mjs,market-cache.mjs,fred-provider.mjs,package.json,package-lock.json,server.test.mjs,fred-provider.test.mjs} "oracle:$stage/"
ssh oracle "cd '$stage' && npm ci --omit=dev && npm test && npm audit --omit=dev"
ssh oracle "bash -s -- '$stage'" <<'SH'
set -eu
stage=$1
api=/opt/finance-dashboard/vps-api
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$api.backup.$stamp"
previous_modules="$api.modules.$stamp"
sudo cp -a "$api" "$backup"
printf 'Rollback backup: %s\n' "$backup"
sudo install -m 0644 "$stage"/{server.mjs,market-cache.mjs,fred-provider.mjs,package.json,package-lock.json} "$api/"
sudo mv "$api/node_modules" "$previous_modules"
sudo mv "$stage/node_modules" "$api/node_modules"
sudo systemctl restart finance-dashboard-api.service
sudo systemctl is-active finance-dashboard-api.service
SH
```

## 배포 검증

```sh
ssh oracle 'curl -fsS http://127.0.0.1:3000/health'
base=https://winow.duckdns.org
origin=https://winow23v.github.io
curl -fsS -i "$base/health"
curl -fsS -i -H "Origin: $origin" "$base/api/v1/market/snapshot"
curl -fsS -i -H "Origin: $origin" "$base/api/v1/market/history?symbolId=kospi&period=1M"
curl -sS -i "$base/api/v1/market/history?symbolId=kospi&period=bad"
```

Health, Snapshot, History가 200인지, 잘못된 period가 400인지 확인한다. 두 시장 API에서 `Access-Control-Allow-Origin`이 허용된 출처로 한 번만 반환되는지, DEMO 표시와 25개 History 시점이 유지되는지 확인한다. 배포 직후 전용 테스트 IP를 사용할 수 있다면 시장 요청을 같은 60초 구간에 합산 61회 보내 429와 `Retry-After`를 확인한다. 같은 시점에 Health는 별도 한도 내에서 200이어야 한다. Pages에서 DEMO 배지, 차트 로딩, 새로고침 후 관심종목 유지를 확인한다.

## Oracle 롤백

배포 명령이 출력한 백업 경로로 아래 `backup`을 지정한다. 서비스 전체 런타임을 복구하므로 기존 lockfile, 코드 및 설치된 의존성이 함께 돌아온다.

```sh
ssh oracle
```

```sh
set -eu
api=/opt/finance-dashboard/vps-api
backup=/opt/finance-dashboard/vps-api.backup.YYYYMMDDTHHMMSSZ
sudo test -f "$backup/server.mjs"
sudo test -d "$backup/node_modules"
sudo systemctl stop finance-dashboard-api.service
sudo mv "$api" "$api.failed.$(date -u +%Y%m%dT%H%M%SZ)"
sudo cp -a "$backup" "$api"
sudo systemctl start finance-dashboard-api.service
sudo systemctl is-active finance-dashboard-api.service
curl -fsS http://127.0.0.1:3000/health
```

롤백 후 HTTPS Snapshot과 History 및 CORS를 다시 확인한다.

## FRED 1차 연동 및 데이터 사용 범위

| 시계열 | 용도 | 원 제공기관 |
| --- | --- | --- |
| [DFEDTARU](https://fred.stlouisfed.org/series/DFEDTARU) | 연방기금금리 목표 범위 상단 | Federal Reserve Board |
| [DGS10](https://fred.stlouisfed.org/series/DGS10) | 미국 10년 만기 국채 수익률 | Federal Reserve Board |
| [CPIAUCSL 및 CPIAUCSL_YOY](https://fred.stlouisfed.org/series/CPIAUCSL) | 계절조정 CPI 원지수와 전년 동월 대비 계산값 | U.S. Bureau of Labor Statistics |
| [UNRATE](https://fred.stlouisfed.org/series/UNRATE) | 계절조정 실업률 | U.S. Bureau of Labor Statistics |

FRED는 각 시계열에 `Public Domain: Citation Requested`를 표시한다. 원 제공기관의 공개 도메인 정책과 FRED 서비스의 이용 조건은 각각 적용된다. FRED 약관은 제한된 시계열을 사용하는 앱을 허용하는 사례로 들며, 데이터 권리 준수, 출처 표기 및 다른 이용자에게 제공할 때 적용되는 조건을 명시한다. 이 프로젝트의 공개 무인증 재배포 API와 캐싱 방식까지 명확히 허용되는지는 확인하지 못했다. 이번 버전은 개인 검증용 루프백 모드만 제공한다. 실제 응답은 파일, DB, 앱 캐시 또는 브라우저 저장소에 기록하지 않으며, API는 `Cache-Control: no-store`를 반환한다. 진행 중인 동일 요청만 공유한다. [FRED 서비스 약관](https://fred.stlouisfed.org/legal/terms/) · [FRED API 이용약관](https://fred.stlouisfed.org/docs/api/terms_of_use.html) · [Federal Reserve Board 권리 정책](https://www.federalreserve.gov/disclaimer.htm) · [BLS 권리 정책](https://www.bls.gov/opub/copyright-information.htm)

[시계열 메타데이터](https://fred.stlouisfed.org/docs/api/fred/series.html)의 ID·주기·단위를 확인하고 [관측 API](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)의 원시 관측값을 사용한다. CPI 상승률은 동일한 계절조정 시계열에 대해 `(해당 월 지수 / 정확히 12개월 전 지수 - 1) × 100`으로 계산한다. 일별 시계열의 휴일 등 결측은 건너뛰며, 최신 월별 관측값 또는 필요한 비교값이 없으면 해당 수치를 `null`로 반환한다. `stale`은 관측일 기준 3일(상단), 7일(국채), 62일(월별) 이상 경과했음을 나타내는 화면 표시용 기준이다. 공식 발표일은 `null`이며, 이를 표시하려면 FOMC, H.15 또는 BLS의 발표 기록처럼 관측 기간과 공식 발표일을 연결할 별도 원본 자료가 필요하다. 수집 시각과 FRED의 메타데이터 갱신일은 공식 발표일로 사용하지 않는다.

### 키 설정과 실제 API 테스트

재발급 가능한 본인용 [FRED API 키](https://fred.stlouisfed.org/docs/api/api_key.html)를 사용한다. 로컬 또는 SSH로 접속한 Oracle 저장소에서 다음 명령을 Bash로 실행한다. 키는 서버 프로세스 환경변수에만 전달하며 Vite, GitHub Pages와 Nginx에 설정하지 않는다.

```bash
(
  read -rsp 'FRED_API_KEY: ' FRED_API_KEY
  printf '\n'
  export FRED_API_KEY
  FRED_PRIVATE_MODE=1 npm --prefix vps-api start
)
```

별도 터미널에서 다음 명령으로 실제 FRED 연동을 확인한다. 명령줄과 출력에 API 키가 포함되지 않는다.

```sh
curl -fsS -i http://127.0.0.1:3001/api/v1/economy/indicators
```

개인 검증 서버가 Oracle에 있으면 Oracle에서 직접 `curl`을 실행하거나, 로컬에서 `ssh -NT -L 127.0.0.1:3001:127.0.0.1:3001 oracle`을 실행해 루프백 포트를 전달한다. 같은 컴퓨터의 Vite 개발 서버는 다음과 같이 연결한다.

```sh
VITE_DATA_MODE=api FINANCE_DEV_API_TARGET=http://127.0.0.1:3001 npm run dev -- --host 127.0.0.1
```

응답이 200이면 항목 5개, 원 제공기관, 관측일, `releaseDate: null`, 수집 시각과 `Cache-Control: no-store`를 확인한다. 공급자 오류는 502, 제한·타임아웃·키 미설정은 503이다. 키 없는 개발 환경에서 `npm test`는 모의 공급자만 호출한다.

### Oracle 배포와 FRED 롤백

위의 [Oracle 배포 명령](#oracle-배포-명령)은 FRED 모듈과 테스트 파일도 스테이징한다. Oracle의 운영 서비스에서는 `FRED_PRIVATE_MODE`를 설정하지 않는다. 공개 Nginx는 기존 Fastify 루프백 3000 포트를 계속 사용하며 3001을 프록시하지 않는다. 공개 경로로 전달되는 새 경제지표 요청은 `503 FRED_DISABLED`를 반환하고, 기존 Health·Snapshot·History와 HTTPS/CORS 정책은 유지된다. 공개 경로가 전달되는 환경이라면 다음 명령으로 비활성 응답과 기존 CORS 헤더를 확인한다.

```sh
curl -sS -i -H 'Origin: https://winow23v.github.io' \
  https://winow.duckdns.org/api/v1/economy/indicators
```

개인 테스트만 종료할 때는 3001 프로세스와 SSH 터널을 중단한다. 서버 버전 복원은 [Oracle 롤백](#oracle-롤백)의 런타임 백업을 사용한다. GitHub Pages까지 배포한 뒤 화면을 복원해야 하는 경우 이전에 검증된 커밋의 Pages 워크플로를 다시 배포한다.
