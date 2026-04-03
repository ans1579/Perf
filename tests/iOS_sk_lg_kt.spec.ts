import { test } from "@playwright/test";
import { openDriver } from "../utils/appium";
import { runPerfBatch } from "../utils/perfRunner";

const APP_SK = {
    target: "T 우주",
    pkg: "com.sktelecom.ios.tuniverse",
};

const APP_U = {
    target: "유독",
    pkg: "com.lguplus.mobile.cs",
};

const APP_KT = {
    target: "마이케이티",
    pkg: "kr.co.show.cs.full",
};

const PLATFORM = "ios" as const;
const DEVICE_NAME = "iPhone 11 Pro";
const REPEAT = 1;
const STEP_TIMEOUT = 30_000;

// iOS 안정성/정확도 우선 프로파일
process.env.PERF_IOS_XCTRACE_MS ??= "1800";
process.env.PERF_IOS_CPU_DIRECT_WEIGHT ??= "1";
process.env.PERF_SAMPLE_START_DELAY_MS ??= "0";
process.env.PERF_TAIL_ATTEMPTS ??= "2";
process.env.PERF_MEMORY_AFTER_RETRIES ??= "2";
process.env.PERF_CURRENT_SCOPE ??= "run";

const CASE_DEFAULTS = {
    platform: PLATFORM,
    deviceName: DEVICE_NAME,
    noProcessMemoryAsZero: true,
    sampleMs: 1000,
    minCpuSamples: 2,
    minCurrentSamples: 2,
    sampleGateRetries: 0,
    caseNo: "001",
    caseName: "앱 실행",
};

const BATCH_DEFAULTS = {
    continueOnError: false,
    finalize: true,
    warmupPerCase: false,
};

type Flow = {
    target: string;
    pkg: string;
    processHints?: string[];
    beforeRun: () => Promise<void>;
    run: () => Promise<void>;
    afterRun?: () => Promise<void>;
};

const ignore = () => {};

test("T 우주 vs 유독 vs 마이케이티 실행 성능 비교", async () => {
    const driver = await openDriver(PLATFORM);

    const terminate = (pkg: string) => driver.terminateApp(pkg).catch(ignore);

    const toCase = (flow: Flow) => ({
        ...CASE_DEFAULTS,
        target: flow.target,
        samplerAppPackage: flow.pkg,
        samplerProcessHints: flow.processHints,
        beforeRun: flow.beforeRun,
        run: flow.run,
        afterRun: flow.afterRun,
    });

    const flows: Flow[] = [
        {
            target: APP_SK.target,
            pkg: APP_SK.pkg,
            processHints: ["Tuniverse"],
            beforeRun: async () => {
                await terminate(APP_SK.pkg);
            },
            run: async () => {
                await driver.activateApp(APP_SK.pkg);
                await driver.$(`//XCUIElementTypeStaticText[@name="전체 카테고리의 인기 상품 확인해 보세요"]`).waitForDisplayed({ timeout: STEP_TIMEOUT });
            },
            afterRun: async () => {
                await terminate(APP_SK.pkg);
            },
        },
        {
            target: APP_U.target,
            pkg: APP_U.pkg,
            processHints: ["cs"],
            beforeRun: async () => {
                await terminate(APP_U.pkg);
                await driver.activateApp(APP_U.pkg);
                await driver.pause(3000);
                await driver.$(`//XCUIElementTypeButton[@name="전체메뉴 열기"]`).click();
                await driver.pause(1000);
                await driver.$(`(//XCUIElementTypeButton[@name="스토어"])[1]`).click();
                await driver.$(`//XCUIElementTypeButton[@name="유독 구독 상품 · MY 구독"]`).click();
            },
            run: async () => {
                await driver.$(`//XCUIElementTypeButton[@name="유독 홈"]`).click();
                await driver.$(`//XCUIElementTypeStaticText[@name="OTT 메뉴 이동"]`).waitForDisplayed({ timeout: STEP_TIMEOUT });
            },
            afterRun: async () => {
                await terminate(APP_U.pkg);
            },
        },
        {
            target: APP_KT.target,
            pkg: APP_KT.pkg,
            processHints: ["KTCS"],
            beforeRun: async () => {
                await terminate(APP_KT.pkg);
                await driver.activateApp(APP_KT.pkg);
                await driver.pause(3000);
                await driver.$(`//XCUIElementTypeButton[@name="메뉴"]`).click();
                await driver.performActions([
                    {
                        type: "pointer",
                        id: "finger1",
                        parameters: { pointerType: "touch" },
                        actions: [
                            { type: "pointerMove", duration: 0, x: 200, y: 670 },
                            { type: "pointerDown", button: 0 },
                            { type: "pause", duration: 120 },
                            { type: "pointerMove", duration: 450, x: 200, y: 230 },
                            { type: "pointerUp", button: 0 },
                        ],
                    },
                ]);
                await driver.releaseActions();
                await driver.pause(2000);
                await driver.$(`//XCUIElementTypeButton[@name="모바일"]`).click();
            },
            run: async () => {
                await driver.$(`//XCUIElementTypeButton[@name="KT 구독 신규메뉴 인기메뉴"]`).click();
                await driver.$(`//XCUIElementTypeStaticText[@name="KT 구독 "]`).waitForDisplayed({ timeout: STEP_TIMEOUT });
            },
            afterRun: async () => {
                await terminate(APP_KT.pkg);
            },
        },
    ];

    const cases = Array.from({ length: REPEAT }, () => flows.map(toCase)).flat();

    try {
        await runPerfBatch({ cases, ...BATCH_DEFAULTS });
    } finally {
        await driver.deleteSession();
    }
});
