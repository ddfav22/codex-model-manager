import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'

import type { IconifyJSON } from '@iconify/types'
import { getIcons, getIconsCSS } from '@iconify/utils'

const sourceRoot = join(__dirname, '..', '..')
const target = join(__dirname, 'generated-icons.css')
const sourceExtensions = new Set(['.css', '.js', '.jsx', '.scss', '.ts', '.tsx'])

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const entryPath = join(directory, entry.name)

    if (entry.isDirectory()) files.push(...(await sourceFiles(entryPath)))
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(entryPath)
  }

  return files
}

async function referencedRemixIcons(): Promise<string[]> {
  const icons = new Set<string>()

  for (const filename of await sourceFiles(sourceRoot)) {
    if (filename === target) continue

    const source = await fs.readFile(filename, 'utf8')

    for (const match of source.matchAll(/\bri-([a-z0-9-]+)\b/g)) icons.add(match[1])
  }

  return [...icons].sort()
}

async function buildIconBundle() {
  const iconNames = await referencedRemixIcons()

  if (!iconNames.length) throw new Error(`No Remix icon references found under ${sourceRoot}`)

  const remixIconSet = JSON.parse(
    await fs.readFile(require.resolve('@iconify/json/json/ri.json'), 'utf8')
  ) as IconifyJSON

  const filteredIconSet = getIcons(remixIconSet, iconNames)

  if (!filteredIconSet) throw new Error('Failed to filter the Remix icon set')

  const bundledNames = new Set([
    ...Object.keys(filteredIconSet.icons || {}),
    ...Object.keys(filteredIconSet.aliases || {})
  ])

  const missingIcons = iconNames.filter(name => !bundledNames.has(name))

  if (missingIcons.length) throw new Error(`Missing Remix icons: ${missingIcons.join(', ')}`)

  const cssContent = getIconsCSS(filteredIconSet, iconNames, { iconSelector: '.{prefix}-{name}' })

  if (!cssContent.trim()) throw new Error('Generated Remix icon CSS is empty')

  await fs.writeFile(target, cssContent, 'utf8')
  console.log(`Saved ${iconNames.length} referenced Remix icons to ${target} (${Buffer.byteLength(cssContent)} bytes)`)
}

buildIconBundle().catch(error => {
  console.error(error)
  process.exitCode = 1
})
