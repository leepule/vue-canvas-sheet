import { buildApp } from './app.js'
import { createProvider } from './ai/provider.js'

const allowedOrigins = (process.env.AI_ALLOWED_ORIGINS ||
  'http://127.0.0.1:8890,http://localhost:8890')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)

const app = buildApp({
  provider: createProvider(process.env),
  allowedOrigins,
  devSessionToken: process.env.AI_DEV_SESSION || 'dev-local',
  logger: process.env.NODE_ENV !== 'test'
})

const host = process.env.AI_HOST || '127.0.0.1'
const port = Number.parseInt(process.env.AI_PORT || '8891', 10)

const close = async () => {
  await app.close()
  process.exit(0)
}

process.on('SIGINT', () => void close())
process.on('SIGTERM', () => void close())

app.listen({ host, port }, (error, address) => {
  if (error) {
    app.log.error(error)
    process.exit(1)
  }
  app.log.info(`AI API listening at ${address} with provider deepseek`)
})
