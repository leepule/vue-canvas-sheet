import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AI_SCHEMA_VERSION,
  AI_CONTRACT_LIMITS,
  AI_ERROR_CODES,
  AIContractError,
  AIErrorSchema,
  AIEventSchema,
  AIResponseSchema,
  AnswerSchema,
  AuthorizationScopeSchema,
  CellCoordinateSchema,
  CellRangeSchema,
  ContentRevisionSchema,
  DocumentIdSchema,
  PlanSchema,
  RequestEnvelopeSchema,
  RequiresInputSchema,
  validatePlanAuthorization
} from '../src/index.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/formula-plan.json', import.meta.url), 'utf8'))

function createPlan() {
  return structuredClone(fixture)
}

// Kept separately from the response under test to model the caller's trusted snapshot.
function createTrustedEnvelope() {
  return {
    schemaVersion: 1,
    runId: 'run-123',
    documentId: 'doc-123',
    documentEpoch: 'epoch-123',
    sheetId: 'sheet-1',
    baseContentRevision: 17,
    allowedReadRanges: [
      { s: { r: 0, c: 0 }, e: { r: 3, c: 1 } }
    ],
    allowedWriteRanges: [
      { s: { r: 1, c: 2 }, e: { r: 3, c: 2 } }
    ]
  }
}

function createRequiresInput() {
  return {
    ...createTrustedEnvelope(),
    kind: 'requires_input',
    questions: ['请选择用于计算销售额的单价列和数量列。'],
    warnings: []
  }
}

function createAnswer() {
  return {
    ...createTrustedEnvelope(),
    kind: 'answer',
    content: '| 单价 | 数量 |\n| --- | --- |\n| 45.50 | 12 |',
    warnings: []
  }
}

function expectAuthorizationFailure(response, envelope, code) {
  expect(AIResponseSchema.safeParse(response).success).toBe(true)
  let failure
  try {
    validatePlanAuthorization(response, envelope)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(AIContractError)
  expect(failure.code).toBe(code)
  expect(failure.retryable).toBe(false)
}

describe('上下文 Schema', () => {
  it('接受零起始坐标、闭区间矩形和可信请求信封', () => {
    expect(CellCoordinateSchema.parse({ r: 0, c: 0 })).toEqual({ r: 0, c: 0 })
    expect(CellRangeSchema.parse({ s: { r: 1, c: 2 }, e: { r: 3, c: 2 } }))
      .toEqual({ s: { r: 1, c: 2 }, e: { r: 3, c: 2 } })
    expect(RequestEnvelopeSchema.parse(createTrustedEnvelope())).toEqual(createTrustedEnvelope())
    expect(ContentRevisionSchema.parse(0)).toBe(0)
  })

  it.each([-1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝非法坐标或修订号 %s，不进行类型转换',
    value => {
      expect(CellCoordinateSchema.safeParse({ r: value, c: 0 }).success).toBe(false)
      expect(CellCoordinateSchema.safeParse({ r: 0, c: value }).success).toBe(false)
      expect(ContentRevisionSchema.safeParse(value).success).toBe(false)
    }
  )

  it.each([
    { s: { r: 2, c: 0 }, e: { r: 1, c: 0 } },
    { s: { r: 0, c: 2 }, e: { r: 0, c: 1 } }
  ])('拒绝倒置的矩形 %j', range => {
    expect(CellRangeSchema.safeParse(range).success).toBe(false)
  })

  it.each(['', ' ', ' doc-123', 'doc-123 ', 'doc\n123', 'x'.repeat(129), 123])(
    '拒绝非法文档 ID %j',
    value => {
      expect(DocumentIdSchema.safeParse(value).success).toBe(false)
    }
  )

  it('允许澄清请求没有授权范围，但拒绝过多范围和未知权限字段', () => {
    expect(AuthorizationScopeSchema.parse({ allowedReadRanges: [], allowedWriteRanges: [] }))
      .toEqual({ allowedReadRanges: [], allowedWriteRanges: [] })
    const scope = {
      allowedReadRanges: Array.from({ length: AI_CONTRACT_LIMITS.maxAuthorizedRanges + 1 }, () => ({
        s: { r: 0, c: 0 }, e: { r: 0, c: 0 }
      })),
      allowedWriteRanges: []
    }
    expect(AuthorizationScopeSchema.safeParse(scope).success).toBe(false)
    expect(AuthorizationScopeSchema.safeParse({
      allowedReadRanges: [], allowedWriteRanges: [], allowAll: true
    }).success).toBe(false)
  })
})

describe('返回类型语法校验', () => {
  it('完整固定计划通过校验，目标为 C2:C4，起始公式为 =A2*B2', () => {
    const plan = PlanSchema.parse(createPlan())

    expect(plan).toEqual(createPlan())
    expect(plan.schemaVersion).toBe(AI_SCHEMA_VERSION)
    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0]).toEqual({
      type: 'fill_formula',
      seedCell: { r: 1, c: 2 },
      seedFormula: '=A2*B2',
      targetRange: { s: { r: 1, c: 2 }, e: { r: 3, c: 2 } }
    })
    expect(AIResponseSchema.parse(plan)).toEqual(plan)
  })

  it('requires_input 必须包含问题，不能包含操作，即使操作数组为空', () => {
    const response = createRequiresInput()

    expect(RequiresInputSchema.parse(response)).toEqual(response)
    expect(AIResponseSchema.parse(response)).toEqual(response)
    expect(AIResponseSchema.safeParse({ ...response, questions: [] }).success).toBe(false)
    expect(AIResponseSchema.safeParse({ ...response, questions: [' '] }).success).toBe(false)
    expect(AIResponseSchema.safeParse({ ...response, operations: [] }).success).toBe(false)
    expect(AIResponseSchema.safeParse({
      ...response, operations: createPlan().operations
    }).success).toBe(false)
    expect(PlanSchema.safeParse(response).success).toBe(false)
  })

  it('接受直接回答结果，不把 Markdown 当作表格计划执行', () => {
    const response = createAnswer()
    expect(AnswerSchema.parse(response)).toEqual(response)
    expect(AIResponseSchema.parse(response)).toEqual(response)
  })

  it.each(['execute_js', 'set_cells', 'trim_text', 'aggregate', 'unknown'])(
    '拒绝未开放操作 %s',
    type => {
      const plan = createPlan()
      plan.operations[0].type = type
      expect(PlanSchema.safeParse(plan).success).toBe(false)
    }
  )

  it.each([
    ['根对象', plan => { plan.extra = true }],
    ['操作', plan => { plan.operations[0].code = 'return 1' }],
    ['起始坐标', plan => { plan.operations[0].seedCell.extra = true }],
    ['目标范围', plan => { plan.operations[0].targetRange.extra = true }],
    ['范围坐标', plan => { plan.operations[0].targetRange.e.extra = true }],
    ['读取授权', plan => { plan.allowedReadRanges[0].extra = true }],
    ['写入授权', plan => { plan.allowedWriteRanges[0].s.extra = true }]
  ])('严格拒绝%s中的未知字段', (_, mutate) => {
    const plan = createPlan()
    mutate(plan)
    expect(PlanSchema.safeParse(plan).success).toBe(false)
  })

  it.each([
    ['负行坐标', plan => { plan.operations[0].targetRange.s.r = -1 }],
    ['负列坐标', plan => { plan.operations[0].seedCell.c = -1 }],
    ['错误版本', plan => { plan.schemaVersion = 2 }],
    ['未知返回类型', plan => { plan.kind = 'execute' }],
    ['缺少操作', plan => { delete plan.operations }],
    ['空操作数组', plan => { plan.operations = [] }],
    ['多个写操作', plan => { plan.operations.push(structuredClone(plan.operations[0])) }],
    ['起始格不在目标起点', plan => { plan.operations[0].seedCell.r = 2 }],
    ['计划混入澄清问题', plan => { plan.questions = ['请选择列'] }]
  ])('拒绝%s', (_, mutate) => {
    const plan = createPlan()
    mutate(plan)
    expect(AIResponseSchema.safeParse(plan).success).toBe(false)
  })

  it.each(['A2*B2', '=', '=   ', '=A2\n*B2', 123, `=${'1'.repeat(4096)}`])(
    '拒绝不符合公式文本格式的输入 %j',
    seedFormula => {
      const plan = createPlan()
      plan.operations[0].seedFormula = seedFormula
      expect(PlanSchema.safeParse(plan).success).toBe(false)
    }
  )

  it('执行目标按包含端点的单元格数计算上限，不允许超大整数溢出绕过限制', () => {
    const plan = createPlan()
    plan.operations[0].targetRange.e.r = AI_CONTRACT_LIMITS.maxWriteCells
    expect(PlanSchema.safeParse(plan).success).toBe(true)

    plan.operations[0].targetRange.e.r += 1
    expect(PlanSchema.safeParse(plan).success).toBe(false)

    plan.operations[0].targetRange.e = { r: Number.MAX_SAFE_INTEGER, c: Number.MAX_SAFE_INTEGER }
    expect(PlanSchema.safeParse(plan).success).toBe(false)
  })

  it('只接受解码后的对象，不从 JSON 字符串或 Markdown 中提取计划', () => {
    expect(AIResponseSchema.safeParse(JSON.stringify(createPlan())).success).toBe(false)
    expect(AIResponseSchema.safeParse(`\`\`\`json\n${JSON.stringify(createPlan())}\n\`\`\``).success).toBe(false)
  })
})

describe('独立授权校验：使用调用方保留的可信信封', () => {
  it('接受正常计划和澄清结果，返回独立对象且不修改输入', () => {
    const plan = createPlan()
    const envelope = createTrustedEnvelope()
    const result = validatePlanAuthorization(plan, envelope)

    expect(result).toEqual(plan)
    expect(result).not.toBe(plan)
    expect(result.operations).not.toBe(plan.operations)
    result.allowedReadRanges[0].e.c = 99
    expect(plan).toEqual(createPlan())
    expect(envelope).toEqual(createTrustedEnvelope())
    expect(validatePlanAuthorization(createRequiresInput(), envelope)).toEqual(createRequiresInput())
  })

  it('拒绝语法合法但位于授权列以外的目标', () => {
    const plan = createPlan()
    plan.operations[0].seedCell.c = 3
    plan.operations[0].targetRange.s.c = 3
    plan.operations[0].targetRange.e.c = 3
    expectAuthorizationFailure(plan, createTrustedEnvelope(), AI_ERROR_CODES.OUT_OF_SCOPE)
  })

  it('拒绝只部分落在授权矩形内的目标', () => {
    const plan = createPlan()
    plan.operations[0].targetRange.e.r = 4
    expectAuthorizationFailure(plan, createTrustedEnvelope(), AI_ERROR_CODES.OUT_OF_SCOPE)
  })

  it('拒绝扩大自报权限后看似合法的目标', () => {
    const plan = createPlan()
    plan.allowedWriteRanges[0].e.c = 3
    plan.operations[0].targetRange.e.c = 3
    expectAuthorizationFailure(plan, createTrustedEnvelope(), AI_ERROR_CODES.OUT_OF_SCOPE)
  })

  it.each(['allowedReadRanges', 'allowedWriteRanges'])('拒绝伪造 %s', field => {
    const plan = createPlan()
    plan[field][0].e.r += 1
    expectAuthorizationFailure(plan, createTrustedEnvelope(), AI_ERROR_CODES.OUT_OF_SCOPE)
  })

  it.each([
    ['runId', 'run-forged', AI_ERROR_CODES.OUT_OF_SCOPE],
    ['documentId', 'doc-forged', AI_ERROR_CODES.OUT_OF_SCOPE],
    ['sheetId', 'sheet-forged', AI_ERROR_CODES.OUT_OF_SCOPE],
    ['documentEpoch', 'epoch-forged', AI_ERROR_CODES.STALE_PREVIEW],
    ['baseContentRevision', 18, AI_ERROR_CODES.STALE_PREVIEW]
  ])('拒绝语法合法但不匹配可信信封的 %s', (field, value, code) => {
    const plan = createPlan()
    plan[field] = value
    expectAuthorizationFailure(plan, createTrustedEnvelope(), code)
  })

  it('可信文档版本变化后拒绝旧计划', () => {
    const envelope = createTrustedEnvelope()
    envelope.baseContentRevision = 18
    expectAuthorizationFailure(createPlan(), envelope, AI_ERROR_CODES.STALE_PREVIEW)
  })

  it('requires_input 同样不能冒用其他文档的信封', () => {
    const response = createRequiresInput()
    response.documentId = 'doc-forged'
    expectAuthorizationFailure(response, createTrustedEnvelope(), AI_ERROR_CODES.OUT_OF_SCOPE)
  })

  it('不将多段授权的外接矩形当作完整授权', () => {
    const envelope = createTrustedEnvelope()
    envelope.allowedWriteRanges = [
      { s: { r: 1, c: 2 }, e: { r: 1, c: 2 } },
      { s: { r: 3, c: 2 }, e: { r: 3, c: 2 } }
    ]
    const plan = createPlan()
    plan.allowedWriteRanges = structuredClone(envelope.allowedWriteRanges)
    expectAuthorizationFailure(plan, envelope, AI_ERROR_CODES.OUT_OF_SCOPE)
  })

  it('M1 要求目标完整位于一个授权矩形内，不自动合并相邻授权', () => {
    const envelope = createTrustedEnvelope()
    envelope.allowedWriteRanges = [
      { s: { r: 1, c: 2 }, e: { r: 2, c: 2 } },
      { s: { r: 3, c: 2 }, e: { r: 3, c: 2 } }
    ]
    const plan = createPlan()
    plan.allowedWriteRanges = structuredClone(envelope.allowedWriteRanges)
    expectAuthorizationFailure(plan, envelope, AI_ERROR_CODES.OUT_OF_SCOPE)

    plan.operations[0].targetRange.e.r = 2
    expect(validatePlanAuthorization(plan, envelope)).toEqual(plan)
  })

  it('没有写授权时拒绝写计划，但允许纯澄清结果', () => {
    const envelope = createTrustedEnvelope()
    envelope.allowedWriteRanges = []
    const plan = createPlan()
    plan.allowedWriteRanges = []
    expectAuthorizationFailure(plan, envelope, AI_ERROR_CODES.OUT_OF_SCOPE)

    const response = createRequiresInput()
    response.allowedWriteRanges = []
    expect(validatePlanAuthorization(response, envelope)).toEqual(response)
  })

  it('授权入口仍拒绝无效响应或不完整的可信信封', () => {
    expect(() => validatePlanAuthorization({ kind: 'plan' }, createTrustedEnvelope()))
      .toThrow(AIContractError)
    expectAuthorizationFailure(createPlan(), {}, AI_ERROR_CODES.INVALID_PLAN)
    expectAuthorizationFailure(createPlan(), {
      ...createTrustedEnvelope(), allowAll: true
    }, AI_ERROR_CODES.INVALID_PLAN)
  })
})

describe('事件与稳定错误结构', () => {
  const eventEnvelope = { schemaVersion: 1, eventId: 1, runId: 'run-123' }
  const error = {
    code: AI_ERROR_CODES.AI_TIMEOUT,
    message: 'Generation timed out',
    retryable: true,
    requestId: 'request-123'
  }

  it.each(['queued', 'generating', 'cancelled'])('接受 %s 状态事件', status => {
    const event = { ...eventEnvelope, type: 'status', status }
    expect(AIEventSchema.parse(event)).toEqual(event)
  })

  it('接受计划就绪、直接回答、待澄清和失败事件', () => {
    for (const event of [
      { ...eventEnvelope, type: 'plan_ready', result: createPlan() },
      { ...eventEnvelope, type: 'answer_ready', result: createAnswer() },
      { ...eventEnvelope, type: 'requires_input', result: createRequiresInput() },
      { ...eventEnvelope, type: 'error', error }
    ]) {
      expect(AIEventSchema.parse(event)).toEqual(event)
    }
  })

  it('事件和结果必须属于同一个 run，且 ready 事件不能携带澄清结果', () => {
    expect(AIEventSchema.safeParse({
      ...eventEnvelope, type: 'plan_ready', result: { ...createPlan(), runId: 'run-forged' }
    }).success).toBe(false)
    expect(AIEventSchema.safeParse({
      ...eventEnvelope, type: 'requires_input', result: { ...createRequiresInput(), runId: 'run-forged' }
    }).success).toBe(false)
    expect(AIEventSchema.safeParse({
      ...eventEnvelope, type: 'plan_ready', result: createRequiresInput()
    }).success).toBe(false)
  })

  it('拒绝未知事件、非法序号、未知字段或用状态代替结果载荷', () => {
    for (const event of [
      { ...eventEnvelope, type: 'execute' },
      { ...eventEnvelope, eventId: 0, type: 'status', status: 'generating' },
      { ...eventEnvelope, eventId: 1.5, type: 'status', status: 'generating' },
      { ...eventEnvelope, type: 'status', status: 'generating', secret: 'hidden' },
      { ...eventEnvelope, type: 'status', status: 'ready' },
      { ...eventEnvelope, type: 'plan_ready' },
      { ...eventEnvelope, type: 'error' }
    ]) {
      expect(AIEventSchema.safeParse(event).success).toBe(false)
    }
  })

  it('错误码集合固定，错误消息不能携带额外堆栈或请求头字段', () => {
    expect(Object.values(AI_ERROR_CODES)).toEqual([
      'INVALID_PLAN', 'UNSUPPORTED_FORMULA', 'OUT_OF_SCOPE', 'READ_ONLY',
      'STALE_PREVIEW', 'LIMIT_EXCEEDED', 'AI_TIMEOUT', 'AI_CANCELLED',
      'APPLY_FAILED', 'LOCAL_SAVE_FAILED', 'VERSION_CONFLICT'
    ])
    expect(Object.isFrozen(AI_ERROR_CODES)).toBe(true)
    expect(AIErrorSchema.parse(error)).toEqual(error)
    for (const invalid of [
      { ...error, code: 'UNKNOWN_ERROR' },
      { ...error, retryable: 'true' },
      { ...error, requestId: '' },
      { ...error, message: ' ' },
      { ...error, stack: 'internal stack' },
      { ...error, headers: { authorization: 'secret' } }
    ]) {
      expect(AIErrorSchema.safeParse(invalid).success).toBe(false)
    }
  })
})
