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
- `npm run test:list`: 테스트 목록 출력
- `npm run report`: Playwright HTML 리포트 열기
- `npm run report:pdf`: `summary.html` 기반으로 `summary.pdf` 생성
- `npm run report:sync-example`: 최신 산출물을 `examples/*`로 동기화
- `npm run report:serve`: summary 정적 서버 실행

## 테스트 작성 규칙
- `runPerfCase`는 케이스 1회 실행 + 메트릭 기록 담당
- 배치(반복 실행) 마지막에 `finalizePerfBatch()`를 1회 호출해 요약 생성
- 즉, 5회 반복이면 1~4회는 기록만 하고, 5회 종료 후 요약을 1번 생성

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

## 환경 변수
### 공통
- `PERF_PLATFORM`: `ios` 또는 `aos` (기본값 `ios`)
- `PERF_SUMMARY_DEVICE_NAME`: summary 표기용 단말명 override
- `PERF_SUMMARY_FORCE`: `1/true`면 변경 감지와 무관하게 summary 강제 재생성

### iOS (`utils/appium.ts`)
- `IOS_APPIUM_HOST`, `IOS_APPIUM_PORT`, `IOS_APPIUM_PATH`
- `IOS_UDID`, `IOS_BUNDLE_ID`
- `IOS_WDA_LOCAL_PORT`
- `IOS_NEW_COMMAND_TIMEOUT`
- `IOS_WDA_CONNECTION_TIMEOUT`
- `IOS_WDA_STARTUP_RETRIES`
- `IOS_WDA_STARTUP_RETRY_INTERVAL`

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

## 산출물 안내
모든 산출물은 `test-output/perf-metrics`에 생성됩니다.

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
- summary 파일이 안 생기면:
  - `runPerfCase` 이후 `finalizePerfBatch()` 호출 여부 확인
  - `test-output/perf-metrics/metrics.jsonl` 생성 여부 확인
- summary가 갱신되지 않는 것 같으면:
  - `PERF_SUMMARY_FORCE=1 npm test`로 강제 재생성 확인
- PDF가 없으면:
  - `npm run report:pdf` 실행
  - 또는 테스트 실행 후 `finalizePerfBatch()` 재호출
- iOS current 값이 비어 있으면:
  - `IOS_CURRENT_CMD` 미설정 상태일 수 있으며, 이 경우 null 처리되는 것이 정상

## examples 폴더 사용법
- `examples/*`는 결과 샘플 참조용입니다.
- 최신 결과로 갱신하려면:
```bash
npm run report:sync-example
```
