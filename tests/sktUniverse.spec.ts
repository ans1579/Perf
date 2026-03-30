import { test } from "@playwright/test";
import { openDriver, AOS } from "../utils/appium";
import { defaultSamplers, runPerfBatch } from "../utils/perfRunner";

test("T 우주 앱 실행", async () => {
    const platform = "aos" as const;
    const driver = await openDriver(platform);

    const repeat = 30; // 반복 횟수

    const base = {
        platform,
        deviceName: "S24-FE",
        target: "T우주",
        samplers: defaultSamplers(platform),
        caseNo: "001",
        caseName: "앱 실행",
        sampleMs: 1000,
        minCpuSamples: 2,
        minCurrentSamples: 1,
        sampleGateRetries: 1,
        // 측정 전 준비(측정 구간 제외)
        beforeRun: async () => {
            await driver.terminateApp(AOS.appPackage).catch(() => {});
            await driver.activateApp(AOS.appPackage);
        },
        run: async () => {
            // 1회 측정 구간: 앱 실행 후 목표 화면 도달까지
            await driver
                .$(
                    `//android.widget.TextView[@text="전체 카테고리의 인기 상품 확인해 보세요"]`,
                )
                .waitForDisplayed({ timeout: 30000 });
        },
        // 측정 후 정리(측정 구간 제외)
        afterRun: async () => {
            await driver.terminateApp(AOS.appPackage);
        },
    };

    try {
        await runPerfBatch({
            cases: Array.from({ length: repeat }, () => ({ ...base })),
            continueOnError: false,
            finalize: true, // 10회 끝난 뒤 summary 1회 생성
            warmupPerCase: false, // 정확히 10회만 실행하려면 false
        });
    } finally {
        await driver.deleteSession();
    }
});
