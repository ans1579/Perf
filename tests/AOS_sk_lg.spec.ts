import { test } from "@playwright/test";
import { openDriver } from "../utils/appium";
import { runPerfBatch } from "../utils/perfRunner";

const APP_T = {
    target: "T 우주",
    pkg: "com.sktelecom.android.tuniverse",
};

const APP_U = {
    target: "유독",
    pkg: "com.lguplus.mobile.cs",
};

type AppFlow = {
    target: string;
    pkg: string;
    caseNo: string;
    caseName: string;
    sampleMs?: number;
    beforeRun: () => Promise<void>;
    run: () => Promise<void>;
    afterRun?: () => Promise<void>;
};

test("T 우주 vs 유독 실행 성능 비교", async () => {
    const platform = "aos" as const;
    const driver = await openDriver(platform);

    const repeat = 5;

    // 앱별로 진입 방식이 다르면 run(측정구간)을 각각 다르게 작성합니다.
    const flows: AppFlow[] = [
        {
            target: APP_T.target,
            pkg: APP_T.pkg,
            caseNo: "001",
            caseName: "앱 실행",
            sampleMs: 1000,
            beforeRun: async () => {
                await driver.terminateApp(APP_T.pkg).catch(() => {});
            },
            run: async () => {
                // T우주 측정구간: 앱 활성화 후 고유 텍스트 확인까지
                await driver.activateApp(APP_T.pkg);
                await driver.$(`//android.widget.TextView[@text="전체 카테고리의 인기 상품 확인해 보세요"]`).waitForDisplayed({ timeout: 30000 });
            },
            afterRun: async () => {
                await driver.terminateApp(APP_T.pkg).catch(() => {});
            },
        },
        {
            target: APP_U.target,
            pkg: APP_U.pkg,
            caseNo: "001",
            caseName: "앱 실행",
            sampleMs: 1000,
            beforeRun: async () => {
                await driver.terminateApp(APP_U.pkg).catch(() => {});
                await driver.activateApp(APP_U.pkg);
                await driver.pause(3000);

                await driver.$(`//*[@text="전체메뉴 열기"]`).click();
                await driver.$(`//android.view.View[@text="스토어"]`).click();
                await driver.$(`//*[@text="유독 구독 상품 · MY 구독"]`).click();
            },
            run: async () => {
                // 유독 측정구간: 앱 메뉴에서 유독 홈 클릭 후 고유 셀렉터 확인까지
                await driver.$(`//*[@text="유독 홈"]`).click();
                await driver.$(`//android.view.View[@content-desc="OTT 메뉴 이동"]`).waitForDisplayed({ timeout: 30000 });
            },
            afterRun: async () => {
                await driver.terminateApp(APP_U.pkg).catch(() => {});
            },
        },
    ];

    // 라운드별로 앱1 -> 앱2 순서로 교차 실행해 시간 드리프트 영향을 줄입니다.
    const cases = Array.from({ length: repeat }, () =>
        flows.map((flow) => ({
            platform,
            deviceName: "S24-FE",
            target: flow.target, // summary 비교 축
            samplerAppPackage: flow.pkg, // 공통 runner sampler가 앱별로 측정
            noProcessMemoryAsZero: true,
            caseNo: flow.caseNo,
            caseName: flow.caseName,
            sampleMs: flow.sampleMs ?? 1000,
            minCpuSamples: 2,
            minCurrentSamples: 1,
            sampleGateRetries: 1,
            beforeRun: flow.beforeRun,
            run: flow.run,
            afterRun: flow.afterRun,
        })),
    ).flat();

    try {
        await runPerfBatch({
            cases,
            continueOnError: false,
            finalize: true,
            warmupPerCase: false,
        });
    } finally {
        await driver.deleteSession();
    }
});
