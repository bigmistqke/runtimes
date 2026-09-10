import type { Plugin } from "vite";

// TypeScript's package.json "types" condition only honors a real .d.ts -
// pointing it at index.js directly (even with full JSDoc, verified
// against a real build) resolves to an implicit `any`, not the JSDoc
// types. Kept in sync with index.js by hand; there's no build step here to
// generate this automatically.

export interface AndroidNapiServeOptions {
  /** File name to copy the built bundle to inside the test-app's assets dir. */
  assetFileName?: string;
  /** Android SDK root. No default - every machine's install differs; pass this or set $ANDROID_HOME. */
  androidHome?: string;
  /** Default: whatever the Android tooling itself defaults to (~/.android) if left unset, or $ANDROID_USER_HOME. */
  androidUserHome?: string;
  /** Default: whatever Gradle itself defaults to (~/.gradle) if left unset, or $GRADLE_USER_HOME. */
  gradleUserHome?: string;
  /** JDK 17+ home. No default - every machine's JDK install differs; pass this or set $JAVA_HOME. */
  javaHome?: string;
  /** Default: "27.1.12297006", or $NDK_VERSION. */
  ndkVersion?: string;
  /** Default: "HERMES", or $GL_ENGINE. */
  glEngine?: string;
  /** Default: read from the connected device via `adb shell getprop ro.product.cpu.abi`, or $TARGET_ABI. */
  targetAbi?: string;
  /** Default: the first connected device from `adb devices`, or $DEVICE_ID. */
  deviceId?: string;
  /** Test-app's Android package name. Default: "com.tns.testapplication". */
  packageName?: string;
  /** Test-app's launcher Activity, fully qualified. Default: "com.tns.NativeScriptActivity". */
  activityName?: string;
  /**
   * The test-app's own stock fixture claiming the same Activity name as
   * every demo bundle - disabled by renaming, rather than deleted, so the
   * checkout itself is never mutated beyond a file rename.
   * Default: "MyActivity.js".
   */
  stockActivityFile?: string;
}

export declare function androidNapiServe(options?: AndroidNapiServeOptions): Plugin;
