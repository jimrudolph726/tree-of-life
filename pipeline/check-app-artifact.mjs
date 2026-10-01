import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('dist')
const datasets = ['life', 'aves', 'primates']
const maxBytes = 32 * 1024 * 1024

async function filesBelow(folder) {
  const entries = await readdir(folder, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const entryPath = path.join(folder, entry.name)
    if (entry.isDirectory()) files.push(...await filesBelow(entryPath))
    else if (entry.isFile()) files.push(entryPath)
  }
  return files
}

for (const required of [
  'index.html',
  'data/profiles/manifest.json',
  'data/journeys/manifest.json',
]) {
  const info = await stat(path.join(root, required)).catch(() => null)
  if (!info?.isFile()) throw new Error(`Missing app artifact: ${required}`)
}

for (const dataset of datasets) {
  const folder = path.join(root, 'data', dataset)
  const entries = await readdir(folder, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  if (entries.length === 0) continue
  if (entries.length !== 1 || !entries[0].isFile() || entries[0].name !== 'manifest.json') {
    throw new Error(`dist/data/${dataset} must contain only manifest.json; immutable tree data belongs in S3`)
  }
}

const files = await filesBelow(root)
const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size))
const totalBytes = sizes.reduce((total, size) => total + size, 0)
if (totalBytes > maxBytes) {
  throw new Error(`App artifact is ${(totalBytes / 1024 / 1024).toFixed(1)} MiB; budget is 32 MiB`)
}

console.log(`App artifact verified: ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`)
