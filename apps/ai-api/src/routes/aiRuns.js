function sseEvent(event) {
  return `id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`
}

function notFound(reply, requestId) {
  return reply.status(404).send({
    error: {
      code: 'INVALID_PLAN',
      message: 'AI run not found',
      retryable: false,
      requestId
    }
  })
}

export function registerAIRuns(app) {
  app.post('/api/ai/runs', async (request, reply) => {
    const idempotencyKey = request.headers['idempotency-key']
    const task = app.runService.createRun({
      idempotencyKey: Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey,
      ownerSession: request.headers['x-dev-session'],
      request: request.body
    })
    return reply.status(202).send(task)
  })

  app.get('/api/ai/runs/:id', async (request, reply) => {
    const task = app.runService.getRun(request.params.id, request.headers['x-dev-session'])
    if (!task) return notFound(reply, request.id)
    return task
  })

  app.get('/api/ai/runs/:id/events', async (request, reply) => {
    const runId = request.params.id
    const ownerSession = request.headers['x-dev-session']
    if (!app.runService.getRun(runId, ownerSession)) return notFound(reply, request.id)

    const lastEventHeader = request.headers['last-event-id']
    let afterEventId = Number.parseInt(Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader, 10)
    if (!Number.isInteger(afterEventId) || afterEventId < 0) afterEventId = 0
    const queryAfter = Number.parseInt(request.query.afterEventId, 10)
    if (Number.isInteger(queryAfter) && queryAfter >= 0) afterEventId = queryAfter

    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...(typeof request.headers.origin === 'string'
        ? { 'access-control-allow-origin': request.headers.origin }
        : {})
    })

    let closed = false
    let timer = null

    const closeStream = () => {
      if (closed) return
      closed = true
      if (timer) clearInterval(timer)
      reply.raw.end()
    }

    const sendPendingEvents = () => {
      const snapshot = app.runService.getEvents(runId, ownerSession, afterEventId)
      if (!snapshot) {
        closeStream()
        return
      }
      for (const event of snapshot.events) {
        reply.raw.write(sseEvent(event))
        afterEventId = event.eventId
      }
      if (snapshot.terminal) closeStream()
    }

    reply.raw.on('close', closeStream)
    timer = setInterval(sendPendingEvents, 25)
    sendPendingEvents()
  })

  app.post('/api/ai/runs/:id/cancel', async (request, reply) => {
    const task = app.runService.cancelRun(request.params.id, request.headers['x-dev-session'])
    if (!task) return notFound(reply, request.id)
    return task
  })
}
