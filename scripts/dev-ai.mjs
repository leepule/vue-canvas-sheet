import { spawn } from 'node:child_process'

const jobs = [
  {
    name: 'api',
    command: 'npm',
    args: ['run', 'dev', '--workspace', '@ai-sheet/api']
  },
  {
    name: 'web',
    command: 'npm',
    args: ['run', 'dev', '--workspace', '@ai-sheet/web']
  }
]

const children = new Set()
let shuttingDown = false

function prefixStream(child, name) {
  const forward = stream => {
    stream.setEncoding('utf8')
    let buffer = ''
    stream.on('data', chunk => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) process.stdout.write(`[${name}] ${line}\n`)
      }
    })
  }
  forward(child.stdout)
  forward(child.stderr)
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
}

for (const job of jobs) {
  const child = spawn(job.command, job.args, {
    cwd: new URL('..', import.meta.url),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.add(child)
  prefixStream(child, job.name)

  child.on('exit', (code, signal) => {
    children.delete(child)
    if (shuttingDown) return
    process.stderr.write(`[${job.name}] exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})\n`)
    shutdown()
    process.exitCode = code === null ? 1 : code
  })
}

process.on('SIGINT', () => {
  shutdown()
})
process.on('SIGTERM', () => {
  shutdown()
})
