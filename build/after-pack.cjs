const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync, statSync } = require('node:fs')
const path = require('node:path')

/**
 * Подпись собранного приложения.
 *
 * Без действительной подписи с запечатанным Info.plist macOS не выдаёт
 * разрешение на запись системного звука: проверка CoreAudio-тапа падает
 * молча, и приложение получает живой, но пустой поток. Поэтому подписываем
 * всегда — хотя бы ad-hoc, если нет сертификата разработчика.
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
      throw new Error(`не удалось подписать ${path.basename(target)}: ${detail}`)
    }
  }

  // Вложенные бинарники подписываются раньше внешнего бандла, иначе подпись
  // приложения окажется недействительной.
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

  // Внешний бандл подписываем с --deep: вложенные подписи после правки
  // ресурсов перестают сходиться, и без него codesign отказывается работать.
  sign(appPath, true, true)
  console.log(`  • подписано ad-hoc  app=${path.basename(appPath)}`)
}
