import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : []
  })
}

describe('motion import discipline', () => {
  it('uses lightweight components with strict LazyMotion', () => {
    const offenders = sourceFiles('src').filter(file => /import\s+\{[^}]*\bmotion\b[^}]*\}\s+from ['"]motion\/react['"]/.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
    expect(readFileSync('src/main.tsx', 'utf8')).toContain('<LazyMotion features={domAnimation} strict>')
  })
})
