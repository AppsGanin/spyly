const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync, statSync } = require('node:fs')
const path = require('node:path')

/**
 * Signs the packaged application.
 *
 * Without a valid signature over a sealed Info.plist, macOS refuses the system
 * audio permission: the CoreAudio tap probe fails silently and the app gets a
 * live but empty stream. So it is always signed — ad-hoc when no Developer ID
 * certificate is available.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const entitlements = path.resolve(__dirname, 'entitlements.mac.plist')
  const identity = process.env.SPYLY_SIGN_IDENTITY || '-'

  const sign = (target, withEntitlements, deep = false) => {
    const args = ['--force', '--sign', identity, '--options', 'runtime', '--timestamp=none']
    if (deep) args.push('--deep')
    if (withEntitlements) args.push('--entitlements', entitlements)
    args.push(target)
    try {
      execFileSync('codesign', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      const detail = error.stderr ? error.stderr.toString().trim() : error.message
      throw new Error(`could not sign ${path.basename(target)}: ${detail}`)
    }
  }

  // Nested binaries are signed before the outer bundle, otherwise the
  // application signature comes out invalid.
  const binDir = path.join(appPath, 'Contents', 'Resources', 'bin')
  if (existsSync(binDir)) {
    for (const name of readdirSync(binDir)) {
      const file = path.join(binDir, name)
      if (statSync(file).isFile()) sign(file, false)
    }
  }

  const frameworks = path.join(appPath, 'Contents', 'Frameworks')
  if (existsSync(frameworks)) {
    for (const name of readdirSync(frameworks)) {
      if (name.endsWith('.app')) sign(path.join(frameworks, name), true)
    }
  }

  // The outer bundle is signed with --deep: after the resources are touched
  // the nested signatures no longer agree, and codesign refuses without it.
  sign(appPath, true, true)
  console.log(`  • signed  identity=${identity === '-' ? 'ad-hoc' : identity}  app=${path.basename(appPath)}`)
}
