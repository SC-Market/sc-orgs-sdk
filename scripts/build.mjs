#!/usr/bin/env node
/** ESM (dist/esm) and CommonJS (dist/cjs) builds with tsc; no bundler. */
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
// Resolved by path, not node_modules/.bin, so it works without bin links.
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc")
const run = (project) => {
  try {
    execFileSync(process.execPath, [tsc, "-p", project], { cwd: ROOT, stdio: "inherit" })
  } catch {
    process.exit(1)
  }
}

rmSync(join(ROOT, "dist"), { recursive: true, force: true })
run("tsconfig.json")
run("tsconfig.cjs.json")
writeFileSync(join(ROOT, "dist/esm/package.json"), '{ "type": "module" }\n')
writeFileSync(join(ROOT, "dist/cjs/package.json"), '{ "type": "commonjs" }\n')
console.log("Built dist/esm and dist/cjs")
