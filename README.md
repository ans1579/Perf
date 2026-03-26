# Perf (Simple Skeleton)

## Structure
- `playwright.config.ts`
- `tests/` (여기에 테스트 파일 직접 작성)
- `utils/appium.ts` (iOS/AOS 드라이버 오픈)
- `utils/perfRunner.ts` (e2e/memory/cpu/current 동시 측정)
- `utils/metric.ts` (메트릭 저장)

## Run
- 전체: `npm test`
- iOS만: `npm run test:ios`
- AOS만: `npm run test:aos`
- 리포트: `npm run report`
- 요약 PDF 생성: `npm run report:pdf`

## One-Test Pattern
아래처럼 테스트 1개에서 4개(E2E/Memory/CPU/Current)를 동시에 측정합니다.

```ts
import { test } from '@playwright/test';
import { currentPlatform, defaultSamplers, runPerfCase } from '../utils/perfRunner';
import { openDriver } from '../utils/appium';

test('perf smoke', async () => {
  const platform = currentPlatform();
  const driver = await openDriver(platform);
  try {
    await runPerfCase({
      platform,
      deviceName: 'iPhone 16 Pro',
      target: '자사앱', // 테스트 파일에서 앱 이름 자유롭게 지정
      caseName: 'smoke',
      samplers: defaultSamplers(platform),
      run: async () => {
        // 여기에 시나리오 작성
        await driver.pause(3000);
      },
    });
  } finally {
    await driver.deleteSession();
  }
});
```

## Output
- 리포트: `test-output/report`
- 메트릭(JSONL/CSV): `test-output/perf-metrics`
- 비교 요약 CSV(사람용): `test-output/perf-metrics/summary.csv`
  - `1) 지표 평균 요약`, `2) 케이스별 비교`, `3) 기준 앱 대비 차이` 섹션 제공
  - 엑셀에서 바로 열어도 읽히도록 한글 헤더 + BOM(UTF-8) 저장
- 비교 요약 CSV(원본형): `test-output/perf-metrics/summary_raw.csv`
- 반복 통계 CSV: `test-output/perf-metrics/summary_stats.csv`
  - min/p5/avg/p95/max + 변동폭 컬럼 포함
- 엑셀 보고서(XLSX): `test-output/perf-metrics/summary.xlsx`
  - `한눈요약`, `케이스비교`, `반복통계` 시트 자동 생성
  - Best/Worst 강조 색상 + 기준앱 상태(우수/보통/개선 필요) 제공
- 비교 대시보드 HTML(그래프 포함): `test-output/perf-metrics/summary.html`
- 비교 대시보드 PDF: `test-output/perf-metrics/summary.pdf`

`summary.csv/html`에는 테스트에서 넘긴 `deviceName`, `target` 값이 그대로 표시됩니다.
