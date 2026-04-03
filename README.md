# Perf

Playwright + Appium 기반 모바일 성능 비교 자동화 프로젝트입니다.  
동일 단말에서 여러 앱(`target`)을 같은 시나리오로 실행하고, `E2E/Memory/CPU/Current`를 수집해 `HTML/CSV/PDF` 요약 리포트를 생성합니다.

## 1) 프로젝트 개요

핵심 목적:
- 같은 단말에서 앱 간 상대 비교
- 반복 실행 기반으로 변동성 완화
- 비개발자도 읽기 쉬운 리포트 제공

핵심 모듈:
- `tests/*`: 앱별 시나리오 정의
- `utils/perfRunner.ts`: 공통 실행 엔진 + iOS/AOS 샘플러
- `utils/metric.ts`: 메트릭 버퍼링/파일 기록
- `utils/summary.ts`: 요약 CSV/HTML/PDF 생성
- `utils/outputPath.ts`: 실행별 출력 디렉터리 관리
- `utils/appium.ts`: iOS/AOS 드라이버 연결

## 2) 디렉터리

- `tests/iOS_sk_lg_kt.spec.ts`: iOS 3앱 비교 샘플
- `tests/AOS_sk_lg.spec.ts`: Android 2앱 비교 샘플
- `utils/perfRunner.ts`: `runPerfCase`, `runPerfBatch`, 플랫폼 샘플러
- `utils/metric.ts`: `metrics.jsonl`, `metrics.csv` 기록
- `utils/summary.ts`: `summary.csv`, `summary_raw.csv`, `summary_stats.csv`, `summary.html`, `summary.pdf`
- `scripts/report-server.js`: summary 정적 서버
- `scripts/export-summary-pdf.js`: PDF 생성
- `examples/*`: 샘플 산출물

## 3) 실행 방법

1. 의존성 설치
```bash
npm install
```

2. 테스트 목록 확인
```bash
npm run test:list
```

3. 실행
```bash
npm run test:ios
npm run test:aos
```

4. 리포트 확인
```bash
npm run report
```

## 4) 주요 npm 스크립트

- `npm test`: 전체 테스트
- `npm run test:ios`: iOS 실행
- `npm run test:aos`: Android 실행
- `npm run test:list`: 테스트 목록 출력
- `npm run report`: Playwright 리포트 열기
- `npm run report:pdf`: `summary.html` -> `summary.pdf`
- `npm run report:serve`: summary 로컬 서버 실행
- `npm run report:sync-example`: 최신 산출물 -> `examples/*` 동기화
- `npm run lint` / `npm run typecheck` / `npm run check`

## 5) 측정 흐름(중요)

`runPerfBatch` -> `runPerfCase` 순서로 동작합니다.

`runPerfCase` 단계:
1. `beforeRun` 실행
2. 샘플링 루프 시작 (`memory/cpu/current`)
3. `run` 실행 (측정 구간)
4. tail/fallback 샘플 보강
5. 메트릭 기록 (`e2e`, `memory.after/peak/delta`, `cpu.avg`, `current.avg`)
6. `afterRun` 실행

샘플 게이트:
- 최소 샘플 수 미달 시 재시도 가능 (`sampleGateRetries`)
- strict 모드가 아니면 게이트 실패여도 완화(`relaxed`) 후 결과 생성

## 6) 플랫폼별 샘플러 요약

### AOS
- Memory: `dumpsys meminfo`
- CPU: `/proc` delta -> `dumpsys cpuinfo` -> `top` fallback
- Current: `sysfs` 우선, 불가 시 `dumpsys battery`

### iOS
- 기본: `xcrun xctrace` record/export로 snapshot 파싱
- CPU: `cpu-percent` 또는 `duration-on-core` delta
- Memory: `physical-footprint`/`resident-size` 우선 파싱
- Current: `idevicediagnostics` (또는 `IOS_CURRENT_CMD`)

## 7) 출력 경로

실행마다 고유 폴더가 생성됩니다.

- 루트: `test-output/perf-metrics`
- 실행 폴더: `test-output/perf-metrics/<runId>`
- 최신 포인터: `test-output/perf-metrics/latest-run.json`
- 최신 복제본: `test-output/perf-metrics/latest/*`

주요 파일:
- `metrics.jsonl`: 원본 이벤트 로그
- `metrics.csv`: 원본 CSV
- `summary.csv`: 사람용 요약
- `summary_raw.csv`: 케이스/지표 원시 비교
- `summary_stats.csv`: min/p5/avg/p95/max
- `summary.html`: 시각화 리포트
- `summary.pdf`: 공유용 PDF

## 8) 자주 쓰는 환경변수

### 공통 실행/출력
- `PERF_PLATFORM`: `ios` | `aos`
- `PERF_RUN_ID` / `PERF_CAMPAIGN_ID`: 실행 폴더명 고정
- `PERF_RUN_LABEL`, `PERF_RUN_DEVICE`: 자동 runId 라벨
- `PERF_PROJECT_ROOT`: 루트 강제 지정

### 공통 샘플 게이트
- `PERF_WARMUP_RUNS`
- `PERF_SAMPLE_GATE_RETRIES`
- `PERF_MIN_CPU_SAMPLES`
- `PERF_MIN_CURRENT_SAMPLES`
- `PERF_SAMPLE_GATE_STRICT`
- `PERF_CURRENT_MEASURE_WHILE_CHARGING`

### 메트릭 기록
- `PERF_WRITE_METRICS_CSV`
- `PERF_BUFFER_METRICS`
- `PERF_METRICS_FLUSH_LINES`

### Summary/PDF
- `PERF_SUMMARY_DEVICE_NAME`
- `PERF_SUMMARY_FORCE`
- `PERF_PDF_FORCE`

### iOS 샘플러
- `PERF_IOS_USE_XCTRACE`
- `PERF_IOS_XCTRACE_MS`
- `PERF_IOS_XCTRACE_RECORD_TIMEOUT_MS`
- `PERF_IOS_XCTRACE_EXPORT_TIMEOUT_MS`
- `PERF_IOS_XCTRACE_LOOP_PAUSE_MS`
- `PERF_IOS_XCTRACE_STOP_WAIT_MS`
- `PERF_IOS_SAMPLER_DEBUG`
- `IOS_MEMORY_CMD`, `IOS_CPU_CMD`, `IOS_CURRENT_CMD`
- `IOS_IDEVICE_PATH`
- `IOS_SAMPLER_BUNDLE_ID`, `IOS_SAMPLER_DEVICE_REF`

### AOS 샘플러
- `PERF_CPU_NORMALIZE_BY_CORES`

### Appium 연결값
- iOS: `IOS_APPIUM_HOST/PORT/PATH`, `IOS_UDID`, `IOS_BUNDLE_ID`, `IOS_WDA_*`, `IOS_WD_CONNECTION_*`
- Android: `AOS_APPIUM_HOST/PORT/PATH`, `AOS_UDID`, `AOS_APP_PACKAGE`, `AOS_APP_ACTIVITY`, `AOS_*_TIMEOUT`, `AOS_CHROMEDRIVER_*`

## 9) 테스트 작성 가이드

권장 패턴:
- 테스트 파일에서 앱별 `beforeRun/run/afterRun`만 정의
- 측정/저장/요약은 `runPerfBatch`에 위임
- 비교 축은 `target` 값으로 통일
- 앱 프로세스 식별 정확도를 위해 iOS는 `samplerProcessHints`를 함께 지정

예시(핵심 형태):
```ts
await runPerfBatch({
  cases: [
    {
      platform: "ios",
      deviceName: "iPhone 11 Pro",
      target: "T 우주",
      samplerAppPackage: "com.sktelecom.ios.tuniverse",
      samplerProcessHints: ["Tuniverse"],
      caseNo: "001",
      caseName: "앱 실행",
      sampleMs: 1000,
      minCpuSamples: 3,
      sampleGateRetries: 0,
      beforeRun: async () => { /* ... */ },
      run: async () => { /* ... */ },
      afterRun: async () => { /* ... */ },
    },
  ],
  finalize: true,
  warmupPerCase: false,
});
```

## 10) 트러블슈팅

### 1) `sample gate relaxed ... cpu 0/x`
- 의미: CPU 샘플 최소치 미달이지만 완화 모드로 결과 생성됨
- 점검:
  - `xctrace record` 실패 로그 존재 여부
  - `minCpuSamples` 과도 설정 여부
  - 측정 구간이 너무 짧은지

### 2) iOS에서 `xctrace snapshot failed`
- `xcrun` 실행 권한/캐시 문제 확인
- 기기 연결 상태/UDID 확인
- 필요 시 `PERF_IOS_SAMPLER_DEBUG=1`로 상세 로그

### 3) 메모리 값이 비정상적으로 낮음
- 현재 코드는 iOS 메모리 파싱에서 `physical-footprint/resident-size` 우선 사용
- `samplerAppPackage`, `samplerProcessHints`가 대상 앱과 맞는지 확인

### 4) summary가 안 갱신됨
- `metrics.jsonl`이 먼저 생성되는지 확인
- `PERF_SUMMARY_FORCE=1`로 강제 재생성 시도

## 11) 운영 팁

- 비교 신뢰도를 위해 최소 `REPEAT=3`, 권장 `5~10`
- 같은 캠페인으로 누적 비교가 필요하면 동일 `PERF_RUN_ID` 사용
- 팀 공유는 `summary.html` + `summary.pdf` 조합 권장

