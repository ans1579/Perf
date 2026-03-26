import { remote } from 'webdriverio';
export type PerfPlatform = 'ios' | 'aos';

export const IOS = {
  host: process.env.IOS_APPIUM_HOST ?? '127.0.0.1',
  port: Number(process.env.IOS_APPIUM_PORT ?? 4724),
  path: process.env.IOS_APPIUM_PATH ?? '/',
  udid: process.env.IOS_UDID ?? '00008140-001C09881E80801C',
  wdaLocalPort: Number(process.env.IOS_WDA_LOCAL_PORT ?? 8102),
  bundleId: process.env.IOS_BUNDLE_ID ?? 'com.sktelecom.miniTworld.ad.stg',
};

export const AOS = {
  host: process.env.AOS_APPIUM_HOST ?? '127.0.0.1',
  port: Number(process.env.AOS_APPIUM_PORT ?? 4723),
  path: process.env.AOS_APPIUM_PATH ?? '/',
  udid: process.env.AOS_UDID ?? 'R3CX60JDSMP',
  appPackage: process.env.AOS_APP_PACKAGE ?? 'Com.sktelecom.minit.ad.stg',
  appActivity:
    process.env.AOS_APP_ACTIVITY ?? 'com.sktelecom.minit.scene.intro.IntroActivity',
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
      'appium:bundleId': IOS.bundleId,
      'appium:wdaLocalPort': IOS.wdaLocalPort,
      'appium:noReset': true,
      'appium:newCommandTimeout': 180,
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
      'appium:appPackage': AOS.appPackage,
      'appium:appActivity': AOS.appActivity,
      'appium:noReset': true,
      'appium:newCommandTimeout': 180,
    },
  });
}

export async function openDriver(platform: PerfPlatform) {
  return platform === 'ios' ? openIosDriver() : openAosDriver();
}
