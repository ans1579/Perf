# Perf

단말 1대에서 여러 앱(`target`)을 동일 시나리오로 반복 실행하고, 성능 지표를 비교 리포트로 만드는 Playwright + Appium 기반 성능 자동화 프로젝트입니다.

## 핵심 목적
- 단말 비교가 아니라, 같은 단말에서 앱 간 비교
- 테스트 파일에서 앱명(`target`)을 자유롭게 지정
- 반복 실행(3~10회 이상) 기반 통계 비교
- 비개발자도 읽기 쉬운 HTML/CSV/PDF 보고서 제공

## 디렉터리 구조
- `playwright.config.ts`: 실행/리포트 기본 설정
- `tests/`: 테스트 파일 작성 위치 (비어 있어도 정상)
- `utils/appium.ts`: iOS/AOS 드라이버 설정 및 연결
- `utils/perfRunner.ts`: 성능 측정 실행기 (`runPerfCase`, `finalizePerfBatch`)
- `utils/metric.ts`: 메트릭 저장 (`metrics.jsonl`, `metrics.csv`)
- `utils/summary.ts`: 요약 산출물 생성 (`summary.csv`, `summary_raw.csv`, `summary_stats.csv`, `summary.html`, `summary.pdf`)
- `scripts/export-summary-pdf.js`: HTML -> PDF 생성
- `scripts/sync-examples.js`: 산출물 예시 파일 동기화

## 빠른 실행
1. 의존성 설치
```bash
npm install
```

2. 테스트 목록 확인
```bash
npm run test:list
```

3. 테스트 실행
```bash
npm test
```

4. 리포트 확인
```bash
npm run report
```

## 스크립트
- `npm test`: 전체 테스트 실행
- `npm run test:ios`: iOS만 실행 (`PERF_PLATFORM=ios`)
- `npm run test:aos`: Android만 실행 (`PERF_PLATFORM=aos`)
- `npm run test:list`: 테스트 목록 출력 (테스트가 없어도 실패 대신 안내 후 성공 처리)
- `npm run test:list:raw`: Playwright 원본 `--list` 동작 그대로 실행
- `npm run lint`: TypeScript 대상 ESLint 검사
- `npm run typecheck`: TypeScript 타입 검사(`tsc --noEmit`)
- `npm run check`: lint + typecheck 일괄 검사
- `npm run report`: Playwright HTML 리포트 열기
- `npm run report:pdf`: `summary.html` 기반으로 `summary.pdf` 생성
- `npm run report:sync-example`: 최신 산출물을 `examples/*`로 동기화
- `npm run report:serve`: summary 정적 서버 실행

## 테스트 작성 규칙
- `runPerfCase`는 케이스 1회 실행 + 메트릭 기록 담당
- `runPerfCase`는 기본적으로 샘플 최소치 게이트를 적용합니다(미달 시 자동 재시도)
- 배치(반복 실행) 마지막에 `finalizePerfBatch()`를 1회 호출해 요약 생성
- 즉, 5회 반복이면 1~4회는 기록만 하고, 5회 종료 후 요약을 1번 생성
- `runPerfBatch`를 사용하면 반복 실행 + 케이스별 1회 워밍업 + 마지막 요약 생성을 한 번에 처리 가능

## 기본 패턴 예시
```ts
import { test } from '@playwright/test';
import { openDriver } from '../utils/appium';
import { currentPlatform, defaultSamplers, runPerfCase, finalizePerfBatch } from '../utils/perfRunner';

test('perf smoke', async () => {
  const platform = currentPlatform();
  const driver = await openDriver(platform);

  try {
    for (let i = 1; i <= 5; i += 1) {
      await runPerfCase({
        platform,
        deviceName: 'iPhone 16 Pro',
        target: '자사앱',
        caseNo: 1,
        caseName: '홈 진입',
        samplers: defaultSamplers(platform),
        run: async () => {
          await driver.pause(3000);
        },
      });
    }

    // 반복 배치 마지막에 summary 1회 생성
    await finalizePerfBatch();
  } finally {
    await driver.deleteSession();
  }
});
```

## 배치 래퍼 예시 (권장)
```ts
import { test } from '@playwright/test';
import { openDriver } from '../utils/appium';
import { runPerfBatch, currentPlatform, defaultSamplers } from '../utils/perfRunner';

test('perf batch', async () => {
  const platform = currentPlatform();
  const driver = await openDriver(platform);

  try {
    await runPerfBatch({
      cases: [
        {
          platform,
          deviceName: 'iPhone 16 Pro',
          target: '자사앱',
          caseNo: 1,
          caseName: '홈 진입',
          samplers: defaultSamplers(platform),
          run: async () => {
            await driver.pause(3000);
          },
        },
      ],
      continueOnError: false,
      finalize: true,
      // 기본값 true: 같은 case/target 조합의 첫 실행은 워밍업(메트릭 미기록)
      warmupPerCase: true,
    });
  } finally {
    await driver.deleteSession();
  }
});
```

## 환경 변수
### 공통
- `PERF_PLATFORM`: `ios` 또는 `aos` (기본값 `ios`)
- `PERF_SUMMARY_DEVICE_NAME`: summary 표기용 단말명 override
- `PERF_SUMMARY_FORCE`: `1/true`면 변경 감지와 무관하게 summary 강제 재생성
- `PERF_WRITE_METRICS_CSV`: `0/false`면 `metrics.csv` 기록 비활성화 (기본값 `1`)
- `PERF_BUFFER_METRICS`: `0/false`면 메트릭 버퍼링 비활성화(즉시 디스크 기록), 기본값 `1`
- `PERF_METRICS_FLUSH_LINES`: 버퍼 모드에서 중간 flush 라인 수(기본값 `25`)
- `PERF_PDF_FORCE`: `1/true`면 PDF 최신 여부와 무관하게 강제 재생성
- `PERF_PDF_NAV_TIMEOUT_MS`: PDF 렌더링 시 `summary.html` 로드 타임아웃(ms)
- `PERF_RUN_ID`: 실행 폴더명을 직접 지정(권장)
- `PERF_CAMPAIGN_ID`: `PERF_RUN_ID` 별칭(동일 의미)
- `PERF_RUN_LABEL`: 자동 생성 폴더명에 붙는 캠페인/테스트 라벨
- `PERF_RUN_DEVICE`: 자동 생성 폴더명에 붙는 단말 라벨(선택)
- `PERF_WARMUP_RUNS`: `runPerfCase` 워밍업 횟수(기본값 `0`)
- `PERF_SAMPLE_GATE_RETRIES`: 샘플 최소치 미달 시 재시도 횟수(기본값 `1`)
- `PERF_MIN_CPU_SAMPLES`: CPU 최소 샘플 수(기본값 `2`)
- `PERF_MIN_CURRENT_SAMPLES`: Current 최소 샘플 수(기본값 `4`)
- `PERF_SAMPLE_GATE_STRICT`: `1/true`면 샘플 게이트 미달 시 테스트 실패(기본은 완화 모드: 결과 생성 우선)
- `PERF_CURRENT_MEASURE_WHILE_CHARGING`: 충전 중 current 수집 허용 여부(기본값 `1`, 끄려면 `0/false`)
  - `1`일 때도 소모 전류 기준을 유지하기 위해 충전 유입 전류(양수)는 `0mA`로 기록

### iOS (`utils/appium.ts`)
- `IOS_APPIUM_HOST`, `IOS_APPIUM_PORT`, `IOS_APPIUM_PATH`
- `IOS_UDID`, `IOS_BUNDLE_ID`
- `IOS_WDA_LOCAL_PORT`
- `IOS_NEW_COMMAND_TIMEOUT`
- `IOS_WDA_CONNECTION_TIMEOUT`
- `IOS_WDA_STARTUP_RETRIES`
- `IOS_WDA_STARTUP_RETRY_INTERVAL`
- `IOS_WD_CONNECTION_RETRY_TIMEOUT`
- `IOS_WD_CONNECTION_RETRY_COUNT`

iOS 성능 샘플러(선택):
- `IOS_MEMORY_CMD`
- `IOS_CPU_CMD`
- `IOS_CURRENT_CMD`

### Android (`utils/appium.ts`)
- `AOS_APPIUM_HOST`, `AOS_APPIUM_PORT`, `AOS_APPIUM_PATH`
- `AOS_UDID`, `AOS_APP_PACKAGE`, `AOS_APP_ACTIVITY`
- `AOS_NEW_COMMAND_TIMEOUT`
- `AOS_ADB_EXEC_TIMEOUT`
- `AOS_UIA2_LAUNCH_TIMEOUT`
- `AOS_ANDROID_INSTALL_TIMEOUT`
- `AOS_WEBVIEW_DEVTOOLS_PORT`
- `AOS_CHROMEDRIVER_PORT` (기본 단일 포트, 기본값 `8000`)
- `AOS_CHROMEDRIVER_PORT_RANGE_START` (범위 시작, 기본값 `9000`)
- `AOS_CHROMEDRIVER_PORT_RANGE_END` (범위 끝, 기본값 `9050`)
- `AOS_WD_CONNECTION_RETRY_TIMEOUT`
- `AOS_WD_CONNECTION_RETRY_COUNT`

Android current 수집 동작:
- `BatteryAverageCurrent`를 우선 사용하고, 없으면 `current_now`로 fallback
- 충전 상태 샘플은 제외
- 수집값 부호를 해석해 방전 전류만 `mA`로 반영

## 산출물 안내
실행마다 고유 폴더가 생성됩니다.

- 루트: `test-output/perf-metrics`
- 실행 폴더(자동): `test-output/perf-metrics/YYYYMMDD-HHmm-캠페인명-단말`
- 자동 이름 충돌 시: `...-r2`, `...-r3` 형태로 분기
- 실행 폴더(고정): `PERF_RUN_ID=<원하는이름>`으로 직접 지정
- 최신 실행 포인터: `test-output/perf-metrics/latest-run.json`
- 고정 최신 경로: `test-output/perf-metrics/latest/summary.html`

참고:
- 최신 산출물은 `latest/`에만 동기화됩니다.
- 루트(`perf-metrics`)는 실행 폴더 + `latest-run.json` 인덱스만 유지합니다.

각 실행 폴더 내부 산출물:
- `metrics.jsonl`: 원본 이벤트 로그(라인 단위 JSON)
- `metrics.csv`: 원본 CSV
- `summary.csv`: 사람용 요약 CSV
- `summary_raw.csv`: 원본형 비교 CSV
- `summary_stats.csv`: 반복 통계 CSV(min/p5/avg/p95/max)
- `summary.html`: 시각화 대시보드
- `summary.pdf`: 공유용 PDF

`summary.html`의 다운로드 버튼은 `CSV`, `통계 CSV`, `PDF`를 제공합니다.

## 리포트 해석 기준
- 낮을수록 우수: `E2E`, `Memory Delta`, `CPU Avg`, `Current Avg`
- Baseline: 테스트에서 처음 등장한 `target`
- 반복 통계: `min / p5 / avg / p95 / max`
- 권장 반복 수: 최소 3회, 권장 5~10회

## 문제 해결 가이드
- 서로 다른 앱 테스트(예: 3개 앱)를 한 페이지에서 비교하고 싶으면:
  - 3개 테스트를 모두 **같은 `PERF_RUN_ID`** 로 실행
  - 그러면 동일 폴더에 누적되어 하나의 `summary.html`에서 비교 가능
  - `PERF_RUN_LABEL`/`PERF_RUN_DEVICE` 자동 방식은 실행별 고유 폴더용(비교 누적용 아님)
  - 예시:
    - `PERF_RUN_ID=20260330-1400-앱3종비교 npm run test:aos -- tests/appA.spec.ts`
    - `PERF_RUN_ID=20260330-1400-앱3종비교 npm run test:aos -- tests/appB.spec.ts`
    - `PERF_RUN_ID=20260330-1400-앱3종비교 npm run test:aos -- tests/appC.spec.ts`
- summary 파일이 안 생기면:
  - `runPerfCase` 이후 `finalizePerfBatch()` 호출 여부 확인
  - 최신 실행 폴더의 `metrics.jsonl` 생성 여부 확인
- summary가 갱신되지 않는 것 같으면:
  - `PERF_SUMMARY_FORCE=1 npm test`로 강제 재생성 확인
- PDF가 없으면:
  - `npm run report:pdf` 실행
  - 또는 테스트 실행 후 `finalizePerfBatch()` 재호출
- PDF를 강제로 다시 만들고 싶으면:
  - `PERF_PDF_FORCE=1 npm run report:pdf`
- iOS current 값이 비어 있으면:
  - `IOS_CURRENT_CMD` 미설정 상태일 수 있으며, 이 경우 null 처리되는 것이 정상

## examples 폴더 사용법
- `examples/*`는 결과 샘플 참조용입니다.
- 최신 결과로 갱신하려면:
```bash
npm run report:sync-example
```
