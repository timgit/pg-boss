import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('.', import.meta.url).pathname, '..')
const packagePath = resolve(root, 'package.json')
const versionPath = resolve(root, 'src', 'version.ts')

const pkgRaw = await readFile(packagePath, 'utf8')
const pkg = JSON.parse(pkgRaw) as { version?: string }

if (!pkg.version) {
  throw new Error('package.json is missing a version field')
}

const contents = `export const version = '${pkg.version}'\n`
await writeFile(versionPath, contents)
