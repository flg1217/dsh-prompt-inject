#!/usr/bin/env node
/**
 * Build @flg1217/dsh-prompt-inject:
 *   1. tsc 编译 src/*.ts → lib/*.js + lib/types/*.d.ts
 *   2. 拷贝客户端 src/client/index.js → lib/client.js(ModuleLoader bundle,
 *      浏览器端由 dsh client-modules 直接托管,无需打包)
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = join(root, '..')
const outDir = join(pkg, 'lib')
const srcDir = join(pkg, 'src')

console.log('build: cleaning lib/')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

console.log('build: tsc (src/*.ts → lib/)')
execFileSync('npx', ['tsc', '-p', join(pkg, 'tsconfig.json')], { stdio: 'inherit', shell: true })

console.log('build: copy client bundle (src/client/index.js → lib/client.js)')
copyFileSync(join(srcDir, 'client', 'index.js'), join(outDir, 'client.js'))
mkdirSync(join(outDir, 'types', 'client'), { recursive: true })
copyFileSync(join(srcDir, 'client', 'index.js'), join(outDir, 'types', 'client', 'index.d.ts'))
