#!/usr/bin/env node
// Generates real TypeScript declarations for the Android SDK, via
// build-tools/android-dts-generator (a real, working tool - was blocked by
// a one-character bug in its own build.gradle, a stray leading space in
// its declared BCEL dependency version breaking Gradle's conflict
// resolution against an older transitive BCEL; fixed alongside this
// script). Writes packages/android-node-api/types/{android,
// android-declarations}.d.ts, referenced by packages/android-node-api/
// index.d.ts - mirrors packages/macos-node-api/index.d.ts's own
// `/// <reference path="./types/index.d.ts" />` pattern, just with two
// files instead of one (that's what the generator itself produces).
//
// Needs $ANDROID_HOME with at least one platform installed (e.g.
// `sdkmanager "platforms;android-34"`) and a JDK 17+ on PATH/$JAVA_HOME -
// dts-generator's own sourceCompatibility requirement.
//
// Runs dts-generator from a copy in a detached temp directory rather than
// in place: it's a real registered subproject of the larger test-app
// Gradle build (see settings.gradle), so running its own wrapper in place
// makes Gradle walk up and configure the *whole* project graph, including
// the `:app` module - which needs a fully set-up Android SDK (local
// properties, build-tools, ...) just to configure, not just build, even
// though dts-generator itself is a plain Java tool with no Android Gradle
// Plugin dependency at all. A detached copy has no parent settings.gradle
// to find, so it configures only itself.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "packages/android-node-api/types");

function findAndroidJar() {
  const androidHome = process.env.ANDROID_HOME;
  if (!androidHome) {
    throw new Error(
      'no $ANDROID_HOME - set it to an Android SDK with at least one platform installed (e.g. `sdkmanager "platforms;android-34"`).',
    );
  }

  const platformsDir = path.join(androidHome, "platforms");
  if (!fs.existsSync(platformsDir)) {
    throw new Error(
      `no platforms installed under ${platformsDir} - install one first (e.g. \`sdkmanager "platforms;android-34"\`).`,
    );
  }

  // Picks the highest installed platform rather than pinning one - any
  // reasonably recent android.jar covers the base SDK surface this
  // generates types for.
  const level = fs
    .readdirSync(platformsDir)
    .map((name) => /^android-(\d+)$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a)[0];
  if (level === undefined) {
    throw new Error(`no "android-<N>" platform directories found under ${platformsDir}.`);
  }

  const jar = path.join(platformsDir, `android-${level}`, "android.jar");
  if (!fs.existsSync(jar)) {
    throw new Error(`expected ${jar} to exist but it doesn't.`);
  }

  console.log(`==> Using android-${level}'s android.jar (highest installed platform)`);
  return jar;
}

function main() {
  const androidJar = findAndroidJar();

  const src = path.join(
    REPO_ROOT,
    "platforms/android/test-app/build-tools/android-dts-generator/dts-generator",
  );
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "android-dts-generator-"));
  fs.cpSync(src, workDir, { recursive: true });

  try {
    console.log("==> Building android-dts-generator");
    execFileSync("./gradlew", ["jar"], { cwd: workDir, stdio: "inherit" });

    // The built jar's name follows the containing directory's name (there's
    // no rootProject.name pin for a standalone run, and workDir is a
    // randomly-named temp dir) - found rather than assumed.
    const libsDir = path.join(workDir, "build/libs");
    const jarName = fs.readdirSync(libsDir).find((name) => name.endsWith(".jar"));
    if (!jarName) {
      throw new Error(`no .jar found in ${libsDir} after building`);
    }

    console.log("==> Generating Android SDK type declarations");
    execFileSync("java", ["-jar", path.join("build/libs", jarName), "-input", androidJar], {
      cwd: workDir,
      stdio: "inherit",
    });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const file of ["android.d.ts", "android-declarations.d.ts"]) {
      fs.copyFileSync(path.join(workDir, "out", file), path.join(OUT_DIR, file));
    }
    console.log(`==> Wrote ${OUT_DIR}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();
