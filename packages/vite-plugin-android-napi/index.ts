import { execFileSync } from "node:child_process";
import { existsSync, copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ResolvedConfig } from "vite";

// Builds a demo bundle (the surrounding `vite build` this plugin hooks
// into), drops it into this repo's own Android test-app
// (platforms/android/test-app), builds the APK, installs it to a connected
// device, and launches it - one command instead of the multi-repo,
// multi-tool workflow this used to be when it lived in a downstream
// consumer's own repo.
//
// Lives here, not in a consumer project, because everything it does is
// really about platforms/android/test-app's own internals (the bundle
// path, assets/app/package.json's "main", the MyActivity.js name
// collision) - knowledge that belongs with the test-app, not scattered
// into every experimental downstream project depending on it. The
// test-app itself stays a generic, unmodified checkout otherwise -
// nothing consumer-specific is committed to it (no bundle, no repointed
// "main"); every bit of that wiring is applied fresh to the filesystem on
// every deploy, here.
//
// Consumed via this repo's root package.json (there's no real
// npm-installable @nativescript/android-node-api yet - see
// packages/android-node-api), subpath "./vite-plugin".

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const TEST_APP = join(REPO_ROOT, "platforms/android/test-app");
const ASSETS_APP = join(TEST_APP, "app/src/main/assets/app");

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
   * every demo bundle (see the closeBundle step below) - disabled by
   * renaming, rather than deleted, so the checkout itself is never mutated
   * beyond a file rename. Default: "MyActivity.js".
   */
  stockActivityFile?: string;
}

export function androidNapiServe(options: AndroidNapiServeOptions = {}): Plugin {
  const assetFileName = options.assetFileName ?? "solid-native-bundle.js";
  const packageName = options.packageName ?? "com.tns.testapplication";
  const activityName = options.activityName ?? "com.tns.NativeScriptActivity";
  const stockActivityFile = options.stockActivityFile ?? "MyActivity.js";

  let config: ResolvedConfig;

  return {
    name: "vite-plugin-android-napi:serve",
    apply: "build",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    closeBundle() {
      if (config.mode !== "serve") return;

      const ANDROID_HOME = options.androidHome ?? process.env.ANDROID_HOME;
      if (!ANDROID_HOME) {
        throw new Error(
          "no ANDROID_HOME - every machine's Android SDK install lives somewhere different, so there's no default. Pass androidHome to androidNapiServe(), or set $ANDROID_HOME.",
        );
      }

      const JAVA_HOME = options.javaHome ?? process.env.JAVA_HOME;
      if (!JAVA_HOME) {
        throw new Error(
          "no JAVA_HOME - every machine's JDK install lives somewhere different, so there's no default. Pass javaHome to androidNapiServe(), or set $JAVA_HOME (needs a JDK 17+).",
        );
      }

      const NDK_VERSION = options.ndkVersion ?? process.env.NDK_VERSION ?? "27.1.12297006";
      const GL_ENGINE = options.glEngine ?? process.env.GL_ENGINE ?? "HERMES";
      const ANDROID_NDK_HOME = join(ANDROID_HOME, "ndk", NDK_VERSION);

      // ANDROID_USER_HOME/GRADLE_USER_HOME are only injected when explicitly
      // given - left unset, the Android tooling and Gradle themselves
      // already fall back to their own standard locations (~/.android,
      // ~/.gradle), which is a better default than this plugin guessing at
      // one.
      const env = {
        ...process.env,
        ANDROID_HOME,
        JAVA_HOME,
        ANDROID_NDK_HOME,
        ...(options.androidUserHome ?? process.env.ANDROID_USER_HOME
          ? { ANDROID_USER_HOME: options.androidUserHome ?? process.env.ANDROID_USER_HOME }
          : {}),
        ...(options.gradleUserHome ?? process.env.GRADLE_USER_HOME
          ? { GRADLE_USER_HOME: options.gradleUserHome ?? process.env.GRADLE_USER_HOME }
          : {}),
      };

      const ADB = join(ANDROID_HOME, "platform-tools/adb");

      // Found up front (rather than only right before `adb install`, like
      // the original script did) because the target ABI below is read off
      // of it - the build itself needs to already know which device it's
      // building for.
      let DEVICE_ID = options.deviceId ?? process.env.DEVICE_ID ?? "";
      if (!DEVICE_ID) {
        const devices = execFileSync(ADB, ["devices"], { env, encoding: "utf8" });
        const line = devices.split("\n").find((l) => l.endsWith("\tdevice"));
        DEVICE_ID = line?.split("\t")[0] ?? "";
      }
      if (!DEVICE_ID) {
        throw new Error("no connected device found (adb devices) - set DEVICE_ID, or plug one in");
      }

      // Read off the actual connected device rather than assuming one fixed
      // ABI, so this isn't tied to whichever device this was first built
      // for.
      const TARGET_ABI =
        options.targetAbi ??
        process.env.TARGET_ABI ??
        execFileSync(ADB, ["-s", DEVICE_ID, "shell", "getprop", "ro.product.cpu.abi"], {
          env,
          encoding: "utf8",
        }).trim();

      // The test-app checkout stays completely generic - it doesn't know
      // what's deploying into it. Rather than requiring
      // assets/app/package.json's "main" to be permanently repointed at the
      // bundle's file name (which would mean committing consumer-specific
      // state to this repo), patch it here on every deploy, same as the
      // bundle copy below. Idempotent: a no-op once it already points at
      // assetFileName.
      const assetsPackageJsonPath = join(ASSETS_APP, "package.json");
      const assetsPackageJson = JSON.parse(readFileSync(assetsPackageJsonPath, "utf8"));
      if (assetsPackageJson.main !== assetFileName) {
        assetsPackageJson.main = assetFileName;
        writeFileSync(assetsPackageJsonPath, JSON.stringify(assetsPackageJson, null, "\t") + "\n");
      }

      // NativeScript's static binding generator scans every .js file under
      // assets/app/ for classes claiming a native name, regardless of
      // "main" - the test-app's own stock fixture claims the exact same
      // "com.tns.NativeScriptActivity" name every demo bundle does, which
      // fails the build outright ("File already exists...") if both are
      // present as .js files. Disabled here by renaming rather than
      // deleting - idempotent, and leaves the checked-in source untouched.
      const stockActivityPath = join(ASSETS_APP, stockActivityFile);
      if (existsSync(stockActivityPath)) {
        renameSync(stockActivityPath, `${stockActivityPath}.disabled`);
      }

      // config.build.outDir stays relative-to-root in the resolved config
      // (Vite only resolves it to absolute internally) - resolve it against
      // config.root explicitly rather than relying on cwd === root.
      const bundlePath = join(config.root, config.build.outDir, "bundle.js");
      const assetPath = join(ASSETS_APP, assetFileName);
      console.log(`==> Copying ${bundlePath} into ${ASSETS_APP}`);
      copyFileSync(bundlePath, assetPath);

      console.log(`==> Building APK (engine=${GL_ENGINE}, abi=${TARGET_ABI})`);
      execFileSync(
        "./gradlew",
        ["assembleDebug", `-Pengine=${GL_ENGINE}`, "-PuseHostObjects", `-PtargetAbi=${TARGET_ABI}`, "--build-cache"],
        { cwd: TEST_APP, env, stdio: "inherit" },
      );

      console.log(`==> Installing to device ${DEVICE_ID}`);
      const apkPath = join(TEST_APP, "app/build/outputs/apk/debug/app-debug.apk");
      execFileSync(ADB, ["-s", DEVICE_ID, "install", "-r", apkPath], { env, stdio: "inherit" });

      console.log("==> Launching");
      execFileSync(ADB, ["-s", DEVICE_ID, "logcat", "-c"], { env, stdio: "inherit" });
      execFileSync(ADB, ["-s", DEVICE_ID, "shell", "am", "force-stop", packageName], {
        env,
        stdio: "inherit",
      });
      execFileSync(ADB, ["-s", DEVICE_ID, "shell", "am", "start", "-n", `${packageName}/${activityName}`], {
        env,
        stdio: "inherit",
      });

      console.log("==> Done. Tail logs with:");
      console.log(`    ${ADB} -s ${DEVICE_ID} logcat | grep ' JS '`);
    },
  };
}
