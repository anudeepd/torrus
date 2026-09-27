import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Every non-test `.ts`/`.tsx` file under `directory`, recursively. */
export function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : []
  })
}
