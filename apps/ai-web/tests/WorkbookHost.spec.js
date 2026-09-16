import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { Workbook } from 'vue-canvas-sheet/core'
import App from '../src/App.vue'
import WorkbookHost from '../src/components/WorkbookHost.vue'
import { createOrdersFixture } from '../../../tests/fixtures/ai-orders.js'

vi.mock('@/components/designer/CanvasTable.vue', async () => {
  const { h } = await import('vue')

  return {
    default: {
      name: 'CanvasTableStub',
      props: ['workbook', 'version', 'readOnly', 'dataController'],
      methods: {
        focus() {},
        scrollIntoView() {}
      },
      render() {
        return h('div', { 'data-testid': 'canvas-table-stub' }, String(this.workbook.getCellValue(1, 0)))
      }
    }
  }
})

describe('WorkbookHost', () => {
  let app
  let container
  let closeSpy

  beforeEach(() => {
    closeSpy = vi.spyOn(Workbook.prototype, 'close')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    app?.unmount()
    app = null
    await Promise.all(closeSpy.mock.results.filter(result => result.type === 'return').map(result => result.value))
    container.remove()
    vi.restoreAllMocks()
  })

  function mountHost(initialData = createOrdersFixture()) {
    const data = shallowRef(initialData)
    const hostRef = shallowRef(null)
    app = createApp({
      render: () => h(WorkbookHost, { ref: hostRef, initialData: data.value })
    })
    app.mount(container)
    return { host: hostRef.value, data }
  }

  it('通过组件 ref 返回真实 Workbook，并载入固定订单', () => {
    const { host } = mountHost()
    const workbook = host.getWorkbook()

    expect(workbook).toBeInstanceOf(Workbook)
    expect([0, 1, 2, 3].map(r => [0, 1, 2].map(c => workbook.getCellValue(r, c))))
      .toEqual(createOrdersFixture())
    expect(container.querySelector('.vue-canvas-sheet')).not.toBeNull()
    expect(container.querySelector('[data-testid="canvas-table-stub"]').textContent).toBe('10')
  })

  it('关闭持久化且不注入自动保存或其他插件', () => {
    const { host } = mountHost()
    const workbook = host.getWorkbook()

    expect(workbook._enablePersistence).toBe(false)
    expect(workbook.plugins.plugins.size).toBe(0)
  })

  it('保持可编辑，修改 A2 不会自动填充结果列或污染夹具', () => {
    const data = createOrdersFixture()
    const { host } = mountHost(data)
    const workbook = host.getWorkbook()

    expect(workbook.readOnly).toBe(false)
    workbook.setCell(1, 0, { v: 12 })

    expect(workbook.getCellValue(1, 0)).toBe(12)
    expect([1, 2, 3].map(r => workbook.getCellValue(r, 2))).toEqual([null, null, null])
    expect(data).toEqual(createOrdersFixture())
  })

  it('新数据引用交由现有组件重载，不重复创建 Workbook', async () => {
    const { host, data } = mountHost()
    const workbook = host.getWorkbook()
    const replacement = createOrdersFixture()
    replacement[1][0] = 7

    data.value = replacement
    await nextTick()

    expect(host.getWorkbook()).toBe(workbook)
    expect(workbook.getCellValue(1, 0)).toBe(7)
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it('卸载后释放 ref，由 TableDesigner 关闭并销毁 Workbook 一次', async () => {
    const { host } = mountHost()
    const workbook = host.getWorkbook()
    const destroySpy = vi.spyOn(workbook, 'destroy')

    app.unmount()
    app = null
    await closeSpy.mock.results[0].value

    expect(host.getWorkbook()).toBeNull()
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(destroySpy).toHaveBeenCalledTimes(1)
  })

  it('重新挂载不会复用已经关闭的 Workbook 或上次编辑结果', async () => {
    const first = mountHost().host.getWorkbook()
    first.setCell(1, 0, { v: 99 })
    app.unmount()
    app = null
    await closeSpy.mock.results[0].value

    const second = mountHost().host.getWorkbook()

    expect(second).not.toBe(first)
    expect(second.getCellValue(1, 0)).toBe(10)
  })

  it('应用首屏挂载订单工作台和待输入 AI 面板', async () => {
    app = createApp(App)
    app.mount(container)

    expect(container.querySelector('.workspace-header h1').textContent).toBe('AI 表格')
    expect(container.querySelector('.workspace-editor .workbook-host')).not.toBeNull()
    expect(container.querySelector('[data-testid="canvas-table-stub"]').textContent).toBe('10')
    expect(container.querySelector('.workspace-ai h2').textContent).toBe('AI')
    expect(container.querySelector('.workspace-ai input, .workspace-ai button')).toBeNull()

    await vi.waitFor(() => {
      expect(container.querySelector('.ai-panel textarea')).not.toBeNull()
    })
    expect(container.querySelector('.ai-panel textarea')).not.toBeNull()
    expect(container.querySelector('.ai-panel-status').textContent).toBe('待输入')
    expect(container.querySelector('.change-preview')).toBeNull()
    expect(container.querySelector('.workspace-ai button.is-primary').disabled).toBe(true)
  })
})
