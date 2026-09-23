# 주영VOICE 버전 및 개발 이력

## 현재 제품 정보

| 항목 | 내용 |
|---|---|
| 공식 이름 | 주영VOICE |
| 한글 표기 | 주영보이스 |
| 현재 기준 버전 | **v1.0.0** |
| 제품 설명 | 실시간 음성·PDF 답사 가이드 |
| 운영 주소 | https://guide-live.juno93.workers.dev |
| Cloudflare Worker 내부 이름 | `guide-live` |
| R2 저장 공간 | `guide-live-pdfs` |
| 최대 참가자 | 방당 50명 |
| 버전 기준일 | 2026-09-23 |

### 현재 운영 확인 정보

- 확인 시각: 2026-09-23
- 현재 Cloudflare 활성 Version ID: `7dafdde3-e970-43a2-9a0e-d014b7301bfa`
- Cloudflare 생성 시각: 2026-09-22 16:12 KST
- 트래픽: 100%
- 주의: 이 배포에는 2026-09-23에 로컬에서 완성한 비밀번호·로고 등 최신 변경이 아직 포함되지 않았을 수 있다. 최신 소스를 배포한 뒤 출력되는 새 Version ID를 v1.0.0 정식 기록에 넣는다.

`guide-live`는 Cloudflare에 등록된 내부 시스템 이름이다. 사용자에게 표시하는 제품 이름은 `주영VOICE`로 통일한다. 내부 이름은 주소와 배포 설정에 영향을 주므로 제품 이름을 바꾸더라도 함부로 변경하지 않는다.

## 버전 번호 규칙

주영VOICE는 `주버전.기능버전.수정버전` 형식을 사용한다.

| 예시 | 의미 |
|---|---|
| `v1.0.1` | 오류 수정, 화면 문구 수정 등 기존 사용법이 바뀌지 않는 업데이트 |
| `v1.1.0` | 새로운 필기 도구, 관리 기능 등 이전 기능과 호환되는 기능 추가 |
| `v2.0.0` | 방 접속 방식, 저장 구조 또는 화면 사용법이 크게 바뀌는 업데이트 |

배포 후보는 `v1.1.0-rc.1`처럼 표시할 수 있다. 현장 사용이 확인된 뒤 `-rc.1`을 제거하고 정식 버전으로 기록한다.

## v1.0.0 기능 기준선

v1.0.0은 문제가 생겼을 때 되돌아갈 첫 번째 안정 기준 버전이다.

- 가이드 1명에서 참가자 최대 50명으로 단방향 실시간 음성 송출
- Cloudflare Realtime SFU와 TURN 우회 연결
- QR 및 링크를 통한 무설치 참가
- 방별 참가 비밀번호와 5회 오류 시 1분 입력 제한
- 인증된 참가자만 음성, PDF, 필기 및 실시간 연결 사용
- PDF.js 기반 세로형 PDF 표시
- 가이드 페이지, 확대 위치 및 필기 실시간 동기화
- 펜, 형광펜, 사각형, 지우개 및 실행 취소
- 레이저 포인터와 꼬리 효과
- 가이드 방송 잠시 멈춤 및 대기 음악
- 참가자의 예·아니요 응답과 10초 집계
- 중복을 줄인 현재 참가자 수 표시
- 모바일 Safari와 Android 브라우저 호환 처리
- 음성 및 WebSocket 자동 재연결
- 참가 종료 버튼
- 방 자동 만료 및 PDF 자동 정리
- 방송 시작 시 방송·QR 영역 자동 접기
- 주영VOICE 인물 로고 적용

## 개발 이력

아래 항목은 v1.0.0 완성 전 개발 과정을 기능 단위로 재구성한 기록이다. 당시 별도의 공식 버전 태그를 만들지 않았으므로 배포 복구 대상으로 사용하지 않는다.

### 2026-09-21

- GuideLive 초기 프로젝트 점검과 로컬 개발 환경 구성
- Cloudflare Workers, Durable Objects, R2 및 Realtime SFU 연결
- `guide-live-pdfs` R2 저장 공간 생성
- `guide-live` Worker 첫 배포
- QR 참가, PDF 표시, 페이지 동기화 및 실시간 필기 구현
- iPhone 음성 자동재생 제한과 WebRTC 연결 문제 보완
- TURN 우회 연결 및 자동 재접속 구현
- 서비스 이름을 `주영VOICE`로 결정

### 2026-09-22

- 방송 잠시 멈춤과 대기 음악 추가
- 참가자 예·아니요 응답 및 가이드 실시간 집계 추가
- 참가자 수 중복 집계 개선
- PDF 도구 모음을 상단으로 이동
- 사각형, 레이저 포인터 및 확대 동기화 추가
- Android 구형 브라우저 호환 코드 추가
- 참가 종료 기능 추가
- 모바일 확대·이동과 포인터 입력 처리 개선

### 2026-09-23

- PDF 확대 비율과 화면 영역 잘림 처리 개선
- 레이저 포인터와 꼬리 움직임 개선
- 방송·QR 영역 접기 및 방송 시작 시 자동 접기 추가
- 참가 비밀번호 인증과 무차별 입력 방지 추가
- 주영VOICE 인물 로고 적용
- **v1.0.0 안정 기준선 확정**

## 업데이트 전 필수 절차

운영 중인 앱을 바로 덮어쓰지 않는다. 다음 순서를 지킨다.

1. 이 문서 상단의 현재 버전을 새 버전 번호로 준비한다.
2. 변경 내용을 이 문서의 `정식 배포 기록`에 적는다.
3. `npm run check`를 실행한다.
4. `npm run build`를 실행한다.
5. 새 방을 만들어 가이드 1대와 참가자 휴대폰 2대로 시험한다.
6. 음성, 재연결, 비밀번호, PDF, 확대, 필기 및 종료를 확인한다.
7. 문제가 없을 때만 운영 배포한다.
8. 배포 결과에 표시되는 `Current Version ID`를 정식 배포 기록에 보관한다.

## 운영 버전 되돌리기

### 가장 빠른 방법

업데이트 직후 문제가 생겼다면 프로젝트 폴더에서 다음 명령을 실행한다.

```powershell
npx wrangler rollback
```

버전 ID를 지정하지 않으면 최신 배포 바로 이전 버전으로 되돌아간다. 실행 전 Cloudflare가 확인 질문을 표시한다.

### 특정 안정 버전으로 되돌리기

최근 배포 목록을 확인한다.

```powershell
npx wrangler deployments list
```

또는 최근 코드 버전을 확인한다.

```powershell
npx wrangler versions list
```

안정적인 버전 ID를 확인한 뒤 다음과 같이 실행한다.

```powershell
npx wrangler rollback 안정적인_VERSION_ID --message "v1.0.0 안정 버전으로 긴급 복구"
```

되돌리기는 즉시 운영 트래픽 전체에 적용된다. Cloudflare 대시보드에서도 `Workers & Pages → guide-live → Deployments`에서 원하는 버전의 메뉴를 열어 `Rollback`을 선택할 수 있다.

Cloudflare는 최근 100개 Worker 버전까지 되돌리기를 지원한다.

## 반드시 알아야 할 복구 한계

Cloudflare Worker 되돌리기는 코드, 정적 화면, 바인딩 및 호환 설정을 이전 버전으로 되돌린다. 다음 항목은 자동으로 과거 상태가 되지 않는다.

- R2에 저장된 PDF 파일
- Durable Objects에 저장된 방과 필기 상태
- 등록된 Secret 값
- 삭제하거나 이름을 변경한 R2 저장 공간
- Durable Object 클래스 구조와 마이그레이션

따라서 저장 구조를 바꾸는 업데이트는 일반 화면 수정과 다르게 취급한다. 기존 필드를 바로 삭제하지 말고 최소 한 버전 동안 이전 필드와 새 필드를 함께 읽을 수 있게 만든다. R2 저장 공간과 Durable Object 바인딩 이름은 안정 버전 복구가 끝날 때까지 삭제하거나 변경하지 않는다.

## 로컬 소스 되돌리기 방안

현재 프로젝트 폴더는 Git 저장소가 아니다. Cloudflare 운영 버전은 되돌릴 수 있지만, 수정 중인 로컬 파일 전체를 정확히 과거 상태로 복원할 수는 없다. 다음 작업으로 Git 버전 관리를 시작하는 것을 권장한다.

최초 한 번만 실행:

```powershell
git init
git add .
git commit -m "주영VOICE v1.0.0 안정 기준선"
git tag -a v1.0.0 -m "첫 안정 버전"
```

업데이트를 시작할 때:

```powershell
git switch -c update/v1.1.0
```

검증이 끝난 뒤:

```powershell
git add .
git commit -m "주영VOICE v1.1.0"
git tag -a v1.1.0 -m "v1.1.0 정식 배포"
```

과거 버전의 소스를 별도 폴더에서 확인하려면 작업 중인 파일을 지우는 명령 대신 다음처럼 새 작업 폴더를 사용한다.

```powershell
git worktree add ..\juyoungvoice-v1.0.0 v1.0.0
```

이 방식은 현재 수정 중인 파일을 보존하면서 과거 버전을 안전하게 열 수 있다.

## 권장 배포 방식

일상적인 업데이트는 아래 3단계로 운영한다.

1. **소스 보존:** Git 커밋과 버전 태그 생성
2. **사전 시험:** Cloudflare Version URL 또는 새 방에서 휴대폰 실기기 점검
3. **운영 배포:** 안정 확인 후 100% 배포하고 Version ID 기록

큰 업데이트는 `wrangler deploy`로 즉시 전체 교체하기보다 `wrangler versions upload`로 먼저 업로드한 뒤 Version URL에서 시험하는 방식이 안전하다. 단, Version URL은 공개 주소일 수 있으므로 실제 비밀 정보나 민감한 PDF를 시험 자료로 사용하지 않는다.

## 장애 발생 시 5분 복구 절차

1. 새 방 생성과 추가 배포를 잠시 중단한다.
2. `npx wrangler deployments status`로 현재 운영 버전을 확인한다.
3. `npx wrangler rollback`을 실행한다.
4. 기존 방이 아니라 새 방을 만들어 음성과 PDF를 확인한다.
5. 정상화되면 실패한 버전과 증상을 정식 배포 기록에 남긴다.
6. 로컬 소스는 Git의 안정 태그를 기준으로 별도 작업 폴더에서 수정한다.

## 정식 배포 기록

| 버전 | 배포일 | Cloudflare Version ID | 상태 | 주요 변경 |
|---|---|---|---|---|
| 이름 미지정 운영본 | 2026-09-22 | `7dafdde3-e970-43a2-9a0e-d014b7301bfa` | 현재 운영 | v1.0.0 확정 전 배포본 |
| v1.0.0 | 배포 예정 | 배포 후 기록 필요 | 로컬 검증 완료 | 음성, PDF, 필기, 확대, 비밀번호, 응답, 모바일 호환 및 주영VOICE 로고 |

앞으로 배포할 때마다 위 표에 새 줄을 추가한다. 문제가 있었던 버전도 삭제하지 않고 상태를 `복구됨`으로 기록한다.

## 공식 참고 자료

- Cloudflare Workers Rollbacks: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
- Cloudflare Workers Versions and Deployments: https://developers.cloudflare.com/workers/versions-and-deployments/
- Wrangler Workers commands: https://developers.cloudflare.com/workers/wrangler/commands/workers/

