import { remote } from "webdriverio";

export type PerfPlatform = "ios" | "aos";

function numEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;

    const text = raw.trim();
    if (!text) return fallback;

    const v = Number(text);
    return Number.isFinite(v) ? v : fallback;
}

function toPositiveInt(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    const asInt = Math.trunc(value);
    return asInt > 0 ? asInt : fallback;
}

export const IOS = {
    host: process.env.IOS_APPIUM_HOST ?? "127.0.0.1",
    port: numEnv("IOS_APPIUM_PORT", 4724),
    path: process.env.IOS_APPIUM_PATH ?? "/",
    udid: process.env.IOS_UDID ?? "00008140-001C09881E80801C",
    bundleId: process.env.IOS_BUNDLE_ID ?? "com.sktelecom.miniTworld.ad.stg",
    wdaLocalPort: numEnv("IOS_WDA_LOCAL_PORT", 8102),
    newCommandTimeoutSec: numEnv("IOS_NEW_COMMAND_TIMEOUT", 300),
    wdaConnectionTimeoutMs: numEnv("IOS_WDA_CONNECTION_TIMEOUT", 120000),
    wdaStartupRetries: numEnv("IOS_WDA_STARTUP_RETRIES", 2),
    wdaStartupRetryIntervalMs: numEnv("IOS_WDA_STARTUP_RETRY_INTERVAL", 10000),
    connectionRetryTimeoutMs: numEnv("IOS_WD_CONNECTION_RETRY_TIMEOUT", 120000),
    connectionRetryCount: numEnv("IOS_WD_CONNECTION_RETRY_COUNT", 2),
};
export const s24Fe = `R3CX60JDSMP`;
// T 우주
export const tUniverse = `com.sktelecom.android.tuniverse`;
export const tUAct = `com.sktelecom.android.tuniverse.ui.main.MainActivity`;
// 마이케이티 - 안드로이드는 x
// 유독(U+one)
export const uPlusOne = `com.lgplus.mobile.cs`;
export const u1Act = `com.lgplus.mobile.cs.activity.main.MainActivity`;

export const AOS = {
    host: process.env.AOS_APPIUM_HOST ?? "127.0.0.1",
    port: numEnv("AOS_APPIUM_PORT", 4723),
    path: process.env.AOS_APPIUM_PATH ?? "/",
    udid: process.env.AOS_UDID ?? s24Fe,
    appPackage: process.env.AOS_APP_PACKAGE ?? tUniverse,
    appActivity: process.env.AOS_APP_ACTIVITY ?? tUAct,
    newCommandTimeoutSec: numEnv("AOS_NEW_COMMAND_TIMEOUT", 300),
    adbExecTimeoutMs: numEnv("AOS_ADB_EXEC_TIMEOUT", 120000),
    uia2LaunchTimeoutMs: numEnv("AOS_UIA2_LAUNCH_TIMEOUT", 120000),
    androidInstallTimeoutMs: numEnv("AOS_ANDROID_INSTALL_TIMEOUT", 120000),
    webviewDevtoolsPort: numEnv("AOS_WEBVIEW_DEVTOOLS_PORT", 10900),
    chromedriverPort: numEnv("AOS_CHROMEDRIVER_PORT", 8000),
    chromedriverPortRangeStart: numEnv(
        "AOS_CHROMEDRIVER_PORT_RANGE_START",
        9000,
    ),
    chromedriverPortRangeEnd: numEnv("AOS_CHROMEDRIVER_PORT_RANGE_END", 9050),
    connectionRetryTimeoutMs: numEnv("AOS_WD_CONNECTION_RETRY_TIMEOUT", 120000),
    connectionRetryCount: numEnv("AOS_WD_CONNECTION_RETRY_COUNT", 2),
};

function getAosChromedriverPorts(): [number, [number, number]] {
    const fixed = toPositiveInt(AOS.chromedriverPort, 8000);
    const start = toPositiveInt(AOS.chromedriverPortRangeStart, 9000);
    const end = toPositiveInt(AOS.chromedriverPortRangeEnd, 9050);
    const [rangeStart, rangeEnd] = start <= end ? [start, end] : [end, start];
    return [fixed, [rangeStart, rangeEnd]];
}

export async function openIosDriver() {
    const capabilities: Record<string, any> = {
        platformName: "iOS",
        "appium:automationName": "XCUITest",
        "appium:udid": IOS.udid,
        "appium:deviceName": IOS.udid,
        "appium:bundleId": IOS.bundleId,

        "appium:noReset": true,
        "appium:newCommandTimeout": IOS.newCommandTimeoutSec,

        // Keep one device/one WDA port for stable parallel isolation.
        "appium:wdaLocalPort": IOS.wdaLocalPort,
        "appium:useNewWDA": false,
        "appium:wdaStartupRetries": IOS.wdaStartupRetries,
        "appium:wdaStartupRetryInterval": IOS.wdaStartupRetryIntervalMs,
        "appium:wdaConnectionTimeout": IOS.wdaConnectionTimeoutMs,

        // Reduce unnecessary idle waits for faster step-to-step flow.
        "appium:waitForQuiescence": false,
        "appium:waitForIdleTimeout": 1,
        "appium:wdaEventloopIdleDelay": 0,
        "appium:disableAutomaticScreenshots": true,
        "appium:simpleIsVisibleCheck": true,
    };

    return remote({
        hostname: IOS.host,
        port: IOS.port,
        path: IOS.path,
        logLevel: "error",
        connectionRetryTimeout: IOS.connectionRetryTimeoutMs,
        connectionRetryCount: IOS.connectionRetryCount,
        capabilities,
    });
}

export async function openAosDriver() {
    const chromedriverPorts = getAosChromedriverPorts();

    const capabilities: Record<string, any> = {
        platformName: "Android",
        "appium:automationName": "UiAutomator2",
        "appium:udid": AOS.udid,
        "appium:deviceName": AOS.udid,

        "appium:appPackage": AOS.appPackage,
        "appium:appActivity": AOS.appActivity,
        "appium:appWaitActivity": "*",

        "appium:noReset": true,
        "appium:fullReset": false,
        "appium:dontStopAppOnReset": true,
        "appium:newCommandTimeout": AOS.newCommandTimeoutSec,
        "appium:adbExecTimeout": AOS.adbExecTimeoutMs,
        "appium:uiautomator2ServerLaunchTimeout": AOS.uia2LaunchTimeoutMs,
        "appium:androidInstallTimeout": AOS.androidInstallTimeoutMs,
        "appium:autoGrantPermissions": true,

        // WebView-heavy perf tests use these by default.
        "appium:autoWebview": false,
        "appium:ensureWebviewsHavePages": true,
        "appium:chromedriverAutodownload": true,
        "appium:recreateChromeDriverSessions": true,
        "appium:webviewDevtoolsPort": toPositiveInt(
            AOS.webviewDevtoolsPort,
            10900,
        ),
        "appium:chromedriverPorts": chromedriverPorts,
    };

    return remote({
        hostname: AOS.host,
        port: AOS.port,
        path: AOS.path,
        logLevel: "error",
        connectionRetryTimeout: AOS.connectionRetryTimeoutMs,
        connectionRetryCount: AOS.connectionRetryCount,
        capabilities,
    });
}

export async function openDriver(platform: PerfPlatform) {
    return platform === "ios" ? openIosDriver() : openAosDriver();
}
