import { remote } from 'webdriverio';

export type PerfPlatform = 'ios' | 'aos';

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export const IOS = {
  host: process.env.IOS_APPIUM_HOST ?? '127.0.0.1',
  port: numEnv('IOS_APPIUM_PORT', 4724),
  path: process.env.IOS_APPIUM_PATH ?? '/',
  udid: process.env.IOS_UDID ?? '00008140-001C09881E80801C',
  bundleId: process.env.IOS_BUNDLE_ID ?? 'com.sktelecom.miniTworld.ad.stg',
  wdaLocalPort: numEnv('IOS_WDA_LOCAL_PORT', 8102),
  newCommandTimeoutSec: numEnv('IOS_NEW_COMMAND_TIMEOUT', 300),
  wdaConnectionTimeoutMs: numEnv('IOS_WDA_CONNECTION_TIMEOUT', 120000),
  wdaStartupRetries: numEnv('IOS_WDA_STARTUP_RETRIES', 2),
  wdaStartupRetryIntervalMs: numEnv('IOS_WDA_STARTUP_RETRY_INTERVAL', 10000),
};

export const AOS = {
  host: process.env.AOS_APPIUM_HOST ?? '127.0.0.1',
  port: numEnv('AOS_APPIUM_PORT', 4723),
  path: process.env.AOS_APPIUM_PATH ?? '/',
  udid: process.env.AOS_UDID ?? 'R3CX60JDSMP',
  appPackage: process.env.AOS_APP_PACKAGE ?? 'Com.sktelecom.minit.ad.stg',
  appActivity: process.env.AOS_APP_ACTIVITY ?? 'com.sktelecom.minit.scene.intro.IntroActivity',
  newCommandTimeoutSec: numEnv('AOS_NEW_COMMAND_TIMEOUT', 300),
  adbExecTimeoutMs: numEnv('AOS_ADB_EXEC_TIMEOUT', 120000),
  uia2LaunchTimeoutMs: numEnv('AOS_UIA2_LAUNCH_TIMEOUT', 120000),
  androidInstallTimeoutMs: numEnv('AOS_ANDROID_INSTALL_TIMEOUT', 120000),
  webviewDevtoolsPort: numEnv('AOS_WEBVIEW_DEVTOOLS_PORT', 10900),
};

export async function openIosDriver() {
  return remote({
    hostname: IOS.host,
    port: IOS.port,
    path: IOS.path,
    logLevel: 'error',
    capabilities: {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:udid': IOS.udid,
      'appium:deviceName': IOS.udid,
      'appium:bundleId': IOS.bundleId,

      'appium:noReset': true,
      'appium:newCommandTimeout': IOS.newCommandTimeoutSec,

      // Keep one device/one WDA port for stable parallel isolation.
      'appium:wdaLocalPort': IOS.wdaLocalPort,
      'appium:useNewWDA': false,
      'appium:wdaStartupRetries': IOS.wdaStartupRetries,
      'appium:wdaStartupRetryInterval': IOS.wdaStartupRetryIntervalMs,
      'appium:wdaConnectionTimeout': IOS.wdaConnectionTimeoutMs,

      // Reduce unnecessary idle waits for faster step-to-step flow.
      'appium:waitForQuiescence': false,
      'appium:waitForIdleTimeout': 1,
      'appium:wdaEventloopIdleDelay': 0,
      'appium:disableAutomaticScreenshots': true,
      'appium:simpleIsVisibleCheck': true,
    },
  });
}

export async function openAosDriver() {
  return remote({
    hostname: AOS.host,
    port: AOS.port,
    path: AOS.path,
    logLevel: 'error',
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': AOS.udid,
      'appium:deviceName': AOS.udid,

      'appium:appPackage': AOS.appPackage,
      'appium:appActivity': AOS.appActivity,
      'appium:appWaitActivity': '*',

      'appium:noReset': true,
      'appium:fullReset': false,
      'appium:dontStopAppOnReset': true,
      'appium:newCommandTimeout': AOS.newCommandTimeoutSec,
      'appium:adbExecTimeout': AOS.adbExecTimeoutMs,
      'appium:uiautomator2ServerLaunchTimeout': AOS.uia2LaunchTimeoutMs,
      'appium:androidInstallTimeout': AOS.androidInstallTimeoutMs,
      'appium:autoGrantPermissions': true,

      // WebView-heavy perf tests use these by default.
      'appium:autoWebview': false,
      'appium:ensureWebviewsHavePages': true,
      'appium:chromedriverAutodownload': true,
      'appium:recreateChromeDriverSessions': true,
      'appium:webviewDevtoolsPort': AOS.webviewDevtoolsPort,
      'appium:chromedriverPorts': [8000, [9000, 9050]],
    },
  });
}

export async function openDriver(platform: PerfPlatform) {
  return platform === 'ios' ? openIosDriver() : openAosDriver();
}
