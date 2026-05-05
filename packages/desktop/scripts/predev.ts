import { $ } from "bun"
import { existsSync, statSync } from "node:fs"
import path from "node:path"

import { copyBinaryToSidecarFolder, getCurrentSidecar, getSidecarTargetPath, windowsify } from "./utils"

const RUST_TARGET = Bun.env.TAURI_ENV_TARGET_TRIPLE

const sidecarConfig = getCurrentSidecar(RUST_TARGET)

const binaryPath = windowsify(`../opencode/dist/${sidecarConfig.ocBinary}/bin/opencode`)

// Cache check. The opencode-cli `bun run build --single` step in
// `packages/opencode/script/build.ts` does `rm -rf dist` plus a
// platform-specific `bun install --os="*" --cpu="*" @opentui/core` —
// each `bun tauri dev` invocation otherwise re-downloads the opentui
// core binaries from npm before vite even gets a chance to start, so
// the dev loop stalls 5+ minutes on every restart. Skip the rebuild
// when the dropped-in sidecar binary already mirrors the source tree.
//
// Heuristic: if the sidecar copy in src-tauri/sidecars/ is newer than
// the backend sources/build inputs, the cached binary is current and
// the predev rebuild is wasted work. Set `GPD_FORCE_PREDEV=1` to
// override (e.g. after pulling new deps).
const sidecarTargetPath = path.resolve(getSidecarTargetPath(sidecarConfig.rustTarget))
const sidecarBinaryName = path.basename(sidecarTargetPath)
const force = Bun.env.GPD_FORCE_PREDEV === "1"

const sourcesNewerThanSidecar = async (): Promise<boolean> => {
  if (!existsSync(sidecarTargetPath)) return true
  const sidecarMtime = statSync(sidecarTargetPath).mtimeMs
  const newest =
    await $`find ../opencode/src ../opencode/script ../opencode/migration ../opencode/package.json ../opencode/tsconfig.json ../../bun.lock -type f -newer ${sidecarTargetPath} -print -quit`
      .nothrow()
      .quiet()
  return newest.stdout.byteLength > 0 || sidecarMtime === 0
}

if (!force && !(await sourcesNewerThanSidecar())) {
  console.log(`predev: sidecar ${sidecarBinaryName} is up-to-date; skipping rebuild`)
} else {
  await (sidecarConfig.ocBinary.includes("-baseline")
    ? $`cd ../opencode && bun run build --single --baseline --skip-install`
    : $`cd ../opencode && bun run build --single --skip-install`)

  await copyBinaryToSidecarFolder(binaryPath, RUST_TARGET)
}
