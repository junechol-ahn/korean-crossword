# 낱말 크로스워드

사전 속 3~6글자 낱말 30개로 만드는 한글 크로스워드 게임입니다.
이지(글자 5개 공개) · 일반 · 하드(5개 단어에 힌트 없음) 난이도, 망치 아이템, 타임 어택, 기록·통계를 지원합니다.

## 로컬 실행

Node.js 22.13 이상이 필요합니다 (내장 SQLite `node:sqlite` 사용, 외부 패키지 없음).

```bash
node server.js            # http://localhost:8765
npm test                  # 서버 테스트 + 퍼즐 생성 검증
```

- 데이터: `data/crossword.db` (SQLite). `node server.js <포트> <데이터 폴더>` 또는 환경 변수 `PORT`, `CROSSWORD_DATA` 로 바꿀 수 있습니다.
- 검증 모드: `http://localhost:8765/?verify`

## 사용자 구분

브라우저 쿠키(`cw_uid`, HttpOnly)의 비밀 토큰으로 사용자를 구분합니다. 같은 와이파이를 쓰는 다른 사람은 다른 사용자가 되고,
휴대폰처럼 IP가 바뀌어도 같은 사용자로 유지됩니다. 쿠키가 생기기 전에 IP로만 만들어진 사용자는 같은 IP에서 처음 접속할 때 이어받습니다.
접속 IP는 `TRUST_PROXY` 설정에 따라 정합니다 (`fly` = Fly-Client-IP, `1` = X-Forwarded-For, 없음 = 소켓 주소).

## Fly.io 배포 (GitHub Actions)

`main` 브랜치에 push 하면 [.github/workflows/fly-deploy.yml](.github/workflows/fly-deploy.yml) 이
테스트 → (처음이면 Fly 앱·디스크 생성) → 배포를 실행합니다. 리전은 도쿄(`nrt`)입니다 (Fly.io에는 서울 리전이 없음).

### 처음 한 번 설정

1. [fly.io](https://fly.io) 가입 후 결제 수단을 등록합니다.
2. Fly.io 토큰을 만듭니다. 처음 배포 때 앱을 만들어야 하므로 **조직(org) 토큰**이 필요합니다.
   - 대시보드: Organization → Tokens → Create token
   - 또는 flyctl: `fly tokens create org`
3. GitHub 저장소 → Settings → Secrets and variables → Actions → **New repository secret**
   이름 `FLY_API_TOKEN`, 값은 2번의 토큰.
4. Actions 탭에서 워크플로를 다시 실행하거나, `main` 에 push 합니다.

배포 주소: `https://<fly.toml 의 app 이름>.fly.dev`

### 운영 메모

- 서버는 1대만 씁니다 (SQLite 파일 하나). `fly scale count` 로 늘리지 마세요.
- 접속이 없으면 서버가 멈췄다가 다음 접속 때 자동으로 켜집니다 (첫 접속이 몇 초 느릴 수 있음).
- 백업: `fly ssh sftp get /data/crossword.db` 또는 Fly 대시보드의 볼륨 스냅샷.
