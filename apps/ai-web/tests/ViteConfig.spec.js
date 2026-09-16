// @vitest-environment node
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import webConfig from '../vite.config.js'
import testConfig from '../vitest.config.js'

const webRoot = resolve(import.meta.dirname, '..')
const componentSource = resolve(webRoot, '../../src')

describe('独立 Web 配置', () => {
  it('使用独立应用根目录和 Vue 插件，不继承库构建', () => {
    expect(webConfig.root).toBe(webRoot)
    expect(webConfig.plugins.map(plugin => plugin.name)).toEqual(['vite:vue'])
    expect(webConfig.build?.lib).toBeUndefined()
    expect(webConfig.resolve.dedupe).toEqual(['vue'])
    expect(webConfig.worker.format).toBe('es')
  })

  it('使用约定端口、API 代理和组件需要的跨源隔离响应头', () => {
    expect(webConfig.server.host).toBe('127.0.0.1')
    expect(webConfig.server.port).toBe(8890)
    expect(webConfig.server.proxy['/api'].target).toBe('http://127.0.0.1:8891')
    expect(webConfig.server.headers).toEqual({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless'
    })
  })

  it('开发模式默认使用同源 API，不要求浏览器直连 8891', async () => {
    const source = await readFile(resolve(webRoot, 'src/views/WorkspaceView.vue'), 'utf8')

    expect(source).toContain("import.meta.env.VITE_AI_API_BASE_URL || '/api'")
    expect(source).not.toContain('http://127.0.0.1:8891/api')
  })

  it.each([
    ['vue-canvas-sheet', 'index.js'],
    ['vue-canvas-sheet/core', 'core/index.js'],
    ['vue-canvas-sheet/plugins', 'plugins/index.js'],
    ['vue-canvas-sheet/wasm', 'wasm/pkg/table_wasm_engine.js']
  ])('%s 只精确匹配对应源码入口', (specifier, sourcePath) => {
    const aliases = webConfig.resolve.alias.filter(alias => alias.find.test(specifier))

    expect(aliases).toHaveLength(1)
    expect(aliases[0].replacement).toBe(resolve(componentSource, sourcePath))
    expect(existsSync(aliases[0].replacement)).toBe(true)
    expect(aliases[0].find.test(`${specifier}/extra`)).toBe(false)
  })

  it('支持组件内部的 @/ 导入，不拦截作用域包或样式子路径', () => {
    const internalAlias = webConfig.resolve.alias.find(alias => alias.find.test('@/core/utils/Clipboard'))

    expect('@/core/utils/Clipboard'.replace(internalAlias.find, internalAlias.replacement))
      .toBe(`${componentSource}/core/utils/Clipboard`)
    for (const specifier of ['@ai-sheet/contracts', 'vue-canvas-sheet/style.css', 'vue-canvas-sheet-other']) {
      expect(webConfig.resolve.alias.some(alias => alias.find.test(specifier))).toBe(false)
    }
  })

  it('测试复用应用解析规则，同时只收集本包用例', () => {
    expect(testConfig.root).toBe(webRoot)
    expect(testConfig.resolve.alias).toEqual(webConfig.resolve.alias)
    expect(testConfig.plugins.map(plugin => plugin.name)).toEqual(['vite:vue'])
    expect(testConfig.test.environment).toBe('jsdom')
    expect(testConfig.test.include).toEqual(['tests/**/*.spec.js'])
    expect(testConfig.test.setupFiles).toBeUndefined()
    expect(testConfig.build?.lib).toBeUndefined()
  })
})
