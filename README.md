# 주영VOICE v1.0.0

> 실시간 음성·PDF 답사 가이드

버전 역사, 업데이트 규칙 및 장애 발생 시 복구 방법은 [`VERSION_HISTORY.md`](./VERSION_HISTORY.md)를 확인하세요.

야외 답사용 **1 → 최대 50명 단방향 실시간 음성 + PDF + 실시간 필기** 웹앱입니다.

- 참가자: 앱 설치 없음, 로그인 없음, QR/링크 접속
- 가이드: 브라우저 마이크로 WebRTC 저지연 송출
- PDF: 가이드가 업로드하면 참가자에게 동일 문서 표시
- 필기: 가이드의 펜/형광펜/지우기/실행취소가 실시간 동기화
- 페이지: 기본적으로 참가자 화면이 가이드를 따라감
- 복구: WebSocket 및 오디오 연결 자동 재시도
- 개인정보: 참가자 이름/이메일 수집 없음
- 방: 자동 만료(2~12시간), PDF와 방 상태 자동 정리

## 아키텍처

```text
가이드 브라우저
  ├─ 마이크 ─ WebRTC ─> Cloudflare Realtime SFU ─> 참가자 1..50 이어폰
  └─ 페이지/펜 ─ WebSocket ─> Durable Object ─> 참가자 1..50 Canvas

PDF 업로드 ─> Cloudflare R2 ─> 각 참가자 브라우저의 PDF.js
```

Cloudflare Realtime 비밀키는 Worker에만 존재하며 브라우저로 전달하지 않습니다.

## 1. 준비

필요한 것:

- Node.js 20+
- Cloudflare 계정
- Cloudflare Realtime App 1개 (App ID / App Secret)
- R2 bucket 1개: `guide-live-pdfs`

Cloudflare Dashboard에서 **Realtime → SFU** 앱을 만든 뒤 App ID와 App Secret을 준비합니다.

R2 bucket:

```bash
npx wrangler r2 bucket create guide-live-pdfs
```

## 2. 설치

```bash
npm install
cp .dev.vars.example .dev.vars
```

Windows PowerShell에서는 `Copy-Item .dev.vars.example .dev.vars`를 사용합니다.

`.dev.vars`:

```env
CF_REALTIME_APP_ID=...
CF_REALTIME_APP_SECRET=...
CREATE_KEY=나만아는-긴-방생성코드
```

- `CF_REALTIME_APP_ID`: Cloudflare Dashboard의 Realtime SFU App ID
- `CF_REALTIME_APP_SECRET`: 같은 앱의 App Secret. 브라우저 코드나 Git에 넣지 않습니다.
- `CREATE_KEY`: 새 답사 방을 만들 때 가이드만 입력하는 충분히 긴 임의 문자열

`.dev.vars`는 로컬 전용이며 Git에서 제외됩니다. 운영값은 아래 `wrangler secret put` 명령으로만 등록합니다.

## 3. 로컬 실행

정적 UI만 확인:

```bash
npm run dev
```

Cloudflare Worker + Durable Object + R2 + Realtime까지 확인:

```bash
npm run cf:dev
```

정적 검사와 프로덕션 빌드:

```bash
npm run check
npm run build
```

로컬 Worker가 실행 중인 별도 터미널에서 API/WebSocket 스모크 테스트:

```bash
npm run smoke
```

스모크 테스트는 방 생성 권한, Durable Object 상태, 가이드·참가자 WebSocket, 페이지 및 필기 동기화, 일회용 오디오 구독 권한, PDF 형식 검사를 확인합니다. 실제 음성 연결에는 유효한 Realtime App ID/Secret이 필요합니다.

마이크는 HTTPS 또는 localhost 보안 컨텍스트가 필요합니다.

## 4. 배포

비밀값 등록:

```bash
npx wrangler secret put CF_REALTIME_APP_ID
npx wrangler secret put CF_REALTIME_APP_SECRET
npx wrangler secret put CREATE_KEY
```

배포:

```bash
npm run deploy
```

처음 한 번은 `npx wrangler login`으로 Cloudflare 계정에 로그인해야 합니다. `wrangler.jsonc`의 R2 버킷 이름을 변경했다면 생성 명령과 바인딩 이름도 동일하게 맞추세요.

배포된 `*.workers.dev` 주소가 바로 서비스 주소입니다. 도메인을 사지 않아도 됩니다.

## 5. 사용법

1. 첫 화면에서 답사 이름 + `CREATE_KEY` 입력 → 방 생성
2. 가이드 화면의 QR을 참가자에게 보여줌
3. PDF 업로드
4. 참가자는 QR → `듣기 시작` → 이어폰 청취
5. 가이드가 `방송 시작`
6. PDF 페이지를 넘기고 Apple Pencil/터치로 필기
7. 참가자 화면은 기본적으로 가이드 페이지를 자동 추적

## 권장 현장 체크

- 전원 이어폰 사용
- 가이드폰은 5G/LTE 수신 상태 확인
- 외장 핀마이크 권장
- 본행사 전 3대 → 10대 → 30~50대 단계 테스트
- iPhone Safari와 Android Chrome을 모두 포함해 테스트
- PDF는 25MB 이하, 이미지가 지나치게 고해상도면 압축 권장

## 브라우저 한계

웹앱이므로 iOS/Android의 절전 정책에 영향을 받을 수 있습니다. PDF를 보면서 듣는 현장 사용을 전제로 화면 깨우기(Screen Wake Lock)를 요청합니다. 화면을 완전히 잠근 상태에서 수 시간 오디오를 보장해야 한다면 차후 네이티브 앱(PWA가 아닌 iOS/Android 앱) 래퍼를 추가하는 편이 안전합니다.

## 보안 설계

- 참가자는 익명 읽기 전용
- 가이드 토큰은 URL query가 아니라 `#fragment`에 보관
- WebSocket 가이드 인증은 60초짜리 일회용 ticket 사용
- 참가자의 Realtime 구독도 연결된 WebSocket에만 발급되는 30초짜리 일회용 ticket 사용
- Realtime App Secret은 Worker 서버에만 저장
- 방 생성 자체는 `CREATE_KEY`로 보호
- 방 자동 만료 시 Durable Object 상태와 R2 PDF 삭제
- CSP/Permissions-Policy/Referrer-Policy 기본 적용

## v1에서 의도적으로 제외한 것

- 녹음/녹화
- 참가자 채팅/발언
- 사용자 계정
- 분석/통계 DB
- 여러 가이드 동시 송출

이 기능들을 넣지 않은 이유는 현장 음성 안정성과 낮은 지연을 최우선으로 유지하기 위해서입니다.

## 배포 후 반드시 할 현장 검증

자동 검증은 Cloudflare 계정 밖에서 실제 SFU 음성 품질을 보장하지 못합니다. 배포 후 다음 순서로 확인하세요.

1. iPhone Safari 가이드 1대 + iPhone/Android 참가자 2~3대로 20분
2. Wi-Fi ↔ LTE/5G 전환 후 자동 재연결
3. Bluetooth/USB-C 핀마이크 교체와 음소거
4. 실제 사용할 PDF의 업로드, 페이지 이동, Apple Pencil 필기
5. 10대, 30대, 50대 순서로 확대해 2시간 연속 실행
