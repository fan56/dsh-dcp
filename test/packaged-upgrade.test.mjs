// pnpm 11 strictDepBuilds regression, see dsh-subagent-registry#10: pnpm 11
// defaults to strictDepBuilds and refuses an install whose dependency carries
// an unapproved preinstall/install/postinstall script, so the dsh host plugin
// manager rolls the update back with ERR_PNPM_IGNORED_BUILDS. This test
// reproduces the npm packaged upgrade path for @aiwayds/dsh-dcp: install the published
// 0.14.0 baseline, upgrade it to the locally packed tarball, then assert
// the shipped package carries no install hook, still ships its bundle patch
// and entry, and still leaves the consumer tree alone.
// Run: node test/packaged-upgrade.test.mjs (needs network access to
// registry.npmjs.org for the 0.14.0 baseline)
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
// Windows needs cmd.exe to launch npm's .cmd shim; keep paths as separate arguments.
const npm = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm'
const npmArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd'] : []
const pkgName = '@aiwayds/dsh-dcp'
const registry = 'https://registry.npmjs.org'
const baselineVersion = '0.14.0'
const installHooks = ['preinstall', 'install', 'postinstall']
const entryFile = ['lib', 'index.js']

const repoManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const repoVersion = repoManifest.version
const bundlePatch = repoManifest.dsh.bundle.patch
const patchFile = bundlePatch.replace(/^\.\//, '')

if (!existsSync(join(repoRoot, ...entryFile))) {
  throw new Error('lib/index.js missing — build before the test chain runs')
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-dcp packaged upgrade-'))
try {
  const consumer = join(scratch, 'consumer')
  const installedDir = join(consumer, 'node_modules', ...pkgName.split('/'))
  const installedManifest = () => JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
  // Same reason as the registry test: a failed guard must reach realpathSync
  // and fail, even on machines without dsh.
  const env = { ...process.env, DSH_CLOSURE_DIR: join(scratch, 'missing-closure') }

  // 1. Baseline: the published release the upgrade starts from.
  const baseline = spawnSync(
    npm,
    [...npmArgs, 'install', `${pkgName}@${baselineVersion}`, '--prefix', consumer, '--no-audit', '--no-fund', '--loglevel=error', `--registry=${registry}`],
    { cwd: scratch, encoding: 'utf8', env },
  )
  assert.equal(baseline.status, 0, `baseline ${baselineVersion} install failed:\n${baseline.stdout}\n${baseline.stderr}`)
  assert.equal(installedManifest().version, baselineVersion, `baseline fixture is ${baselineVersion}`)

  // 2. Pack the repo the way CI's release job does. The tarball name comes
  //    from the filesystem, not stdout: npm 10 still runs the root `prepare`
  //    hook under `--ignore-scripts`, so its log line corrupts `--json`
  //    output. A dedicated empty directory keeps the result unambiguous.
  const packDir = join(scratch, 'pack')
  mkdirSync(packDir)
  execFileSync(npm, [...npmArgs, 'pack', '--pack-destination', packDir], { cwd: repoRoot, encoding: 'utf8' })
  const tarballs = readdirSync(packDir).filter((f) => f.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, `pack emitted exactly one tarball, got ${tarballs.join(', ') || 'none'}`)
  const tarball = join(packDir, tarballs[0])

  // 3. Tarball manifest: the install-hook gate set is empty. `prepare` is
  //    carried in package.json but npm/pnpm never run it for registry
  //    dependencies — the published package has no lifecycle step to gate.
  const tarManifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(tarManifest.version, repoVersion, `packed version is ${repoVersion}`)
  for (const key of installHooks) {
    assert.ok(!Object.hasOwn(tarManifest.scripts ?? {}, key), `tarball manifest carries no ${key} script (#10)`)
  }
  assert.equal(tarManifest.dsh.bundle.patch, bundlePatch, 'bundle patch still declared')

  // 4. Upgrade in place: the plugin manager's exact step. Must exit 0 and
  //    must not produce a pnpm-11 unapproved-build report (the regression
  //    class this test pins).
  const upgrade = spawnSync(
    npm,
    [...npmArgs, 'install', tarball, '--prefix', consumer, '--no-audit', '--no-fund', '--loglevel=error', `--registry=${registry}`],
    { cwd: scratch, encoding: 'utf8', env },
  )
  const output = `${upgrade.stdout ?? ''}\n${upgrade.stderr ?? ''}`
  assert.equal(upgrade.status, 0, `upgrade to the packed ${repoVersion} failed:\n${output}`)
  assert.ok(
    !/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(output),
    `upgrade output carries a pnpm-11 unapproved-build report:\n${output}`,
  )

  const upgraded = installedManifest()
  assert.equal(upgraded.version, repoVersion, `upgrade landed ${repoVersion}`)
  for (const key of installHooks) {
    assert.ok(!Object.hasOwn(upgraded.scripts ?? {}, key), `installed manifest carries no ${key} script (#10)`)
  }
  // The installed manifest must be the packed one: when the repo version and
  // the published baseline share a version number, the version assertion alone
  // cannot tell the tarball apart from the registry copy.
  assert.deepEqual(upgraded, tarManifest, 'the installed manifest is the packed tarball manifest (the upgrade really landed)')
  assert.ok(existsSync(join(installedDir, patchFile)), 'bundle patch ships')
  assert.ok(existsSync(join(installedDir, ...entryFile)), 'plugin entry ships')

  // 5. Consumer safety unchanged: the linker did not touch the consumer tree,
  //    and no optional host SDK peer materialized a second copy.
  assert.ok(
    !existsSync(join(installedDir, 'node_modules', '@deepseek-ai')),
    'linker did not touch the consumer tree (guard markers held)',
  )
  assert.ok(
    !existsSync(join(consumer, 'node_modules', '@deepseek-ai')),
    'optional host SDK peers did not install a consumer-side copy',
  )
  console.log(`packaged-upgrade: ${baselineVersion} → packed ${repoVersion} upgrades cleanly with no install hook`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
