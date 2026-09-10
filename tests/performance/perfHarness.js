import { afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const defaultArtifactDir = join(harnessDir, '.artifacts');
const artifactDir = process.env.PERF_ARTIFACT_DIR || defaultArtifactDir;
const budgetsPath = join(harnessDir, 'perf-budgets.json');
const metrics = [];

let budgets = {};
if (existsSync(budgetsPath)) {
  budgets = JSON.parse(readFileSync(budgetsPath, 'utf8'));
}

function now() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

function memoryUsage() {
  if (globalThis.process?.memoryUsage) {
    return globalThis.process.memoryUsage().heapUsed;
  }
  if (globalThis.performance?.memory?.usedJSHeapSize) {
    return globalThis.performance.memory.usedJSHeapSize;
  }
  return null;
}

function percentile(values, percent) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
  return sorted[index];
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarize(name, samplesMs, memoryDeltas, payloadBytes, options) {
  const total = samplesMs.reduce((sum, value) => sum + value, 0);
  const avg = samplesMs.length > 0 ? total / samplesMs.length : 0;
  const memoryTotal = memoryDeltas.reduce((sum, value) => sum + value, 0);

  return {
    name,
    iterations: samplesMs.length,
    warmup: options.warmup ?? 1,
    samplesMs: samplesMs.map(value => round(value)),
    avgMs: round(avg),
    minMs: round(Math.min(...samplesMs)),
    maxMs: round(Math.max(...samplesMs)),
    p95Ms: round(percentile(samplesMs, 95)),
    p99Ms: round(percentile(samplesMs, 99)),
    memoryDeltaAvgBytes: memoryDeltas.length > 0 ? Math.round(memoryTotal / memoryDeltas.length) : null,
    memoryDeltaMaxBytes: memoryDeltas.length > 0 ? Math.max(...memoryDeltas) : null,
    payloadBytes: payloadBytes.length > 0 ? Math.max(...payloadBytes) : null,
    metadata: options.metadata || {}
  };
}

function evaluateBudget(metric, budget) {
  if (!budget) return [];

  const failures = [];
  const metricName = budget.metric || 'p95Ms';
  const value = metric[metricName];

  if (budget.maxMs !== undefined && value > budget.maxMs) {
    failures.push(`${metricName} ${value}ms exceeded ${budget.maxMs}ms`);
  }
  if (budget.maxPayloadBytes !== undefined && metric.payloadBytes > budget.maxPayloadBytes) {
    failures.push(`payloadBytes ${metric.payloadBytes} exceeded ${budget.maxPayloadBytes}`);
  }
  if (budget.minPayloadBytes !== undefined && metric.payloadBytes < budget.minPayloadBytes) {
    failures.push(`payloadBytes ${metric.payloadBytes} was below ${budget.minPayloadBytes}`);
  }
  if (budget.maxMemoryDeltaBytes !== undefined &&
      metric.memoryDeltaMaxBytes !== null &&
      metric.memoryDeltaMaxBytes > budget.maxMemoryDeltaBytes) {
    failures.push(`memoryDeltaMaxBytes ${metric.memoryDeltaMaxBytes} exceeded ${budget.maxMemoryDeltaBytes}`);
  }

  return failures;
}

async function runOnce(runner, options, iteration, warmup) {
  const context = options.setup
    ? await options.setup({ iteration, warmup })
    : undefined;

  try {
    const startMemory = memoryUsage();
    const start = now();
    const result = await runner(context, { iteration, warmup });
    const duration = now() - start;
    const endMemory = memoryUsage();

    return {
      duration,
      memoryDelta: startMemory !== null && endMemory !== null ? endMemory - startMemory : null,
      result: result || {}
    };
  } finally {
    if (options.teardown) {
      await options.teardown(context, { iteration, warmup });
    }
  }
}

export async function benchmark(name, runner, options = {}) {
  const iterations = options.iterations ?? 5;
  const warmup = options.warmup ?? 1;
  const samplesMs = [];
  const memoryDeltas = [];
  const payloadBytes = [];
  const metadata = { ...(options.metadata || {}) };

  for (let i = 0; i < warmup; i++) {
    await runOnce(runner, options, i, true);
  }

  for (let i = 0; i < iterations; i++) {
    const sample = await runOnce(runner, options, i, false);
    samplesMs.push(sample.duration);

    if (sample.memoryDelta !== null) {
      memoryDeltas.push(sample.memoryDelta);
    }
    if (Number.isFinite(sample.result.payloadBytes)) {
      payloadBytes.push(sample.result.payloadBytes);
    }
    if (sample.result.metadata) {
      Object.assign(metadata, sample.result.metadata);
    }
  }

  const metric = summarize(name, samplesMs, memoryDeltas, payloadBytes, { ...options, warmup, metadata });
  const budget = options.budget === false ? null : (options.budget || budgets[name]);
  const failures = evaluateBudget(metric, budget);

  metric.budget = budget;
  metric.pass = failures.length === 0;
  metric.failures = failures;
  metrics.push(metric);

  if (failures.length > 0) {
    throw new Error(`Performance budget failed for ${name}: ${failures.join('; ')}`);
  }

  return metric;
}

export function cleanupWorkbook(workbook) {
  if (!workbook) return;
  if (workbook.calcEngine?.batchTimeout) {
    clearTimeout(workbook.calcEngine.batchTimeout);
    workbook.calcEngine.batchTimeout = null;
  }
  if (typeof workbook.destroy === 'function') {
    workbook.destroy();
  }
}

afterAll(() => {
  if (metrics.length === 0) return;

  mkdirSync(artifactDir, { recursive: true });
  const shard = {
    generatedAt: new Date().toISOString(),
    pid: globalThis.process?.pid || null,
    metrics
  };
  const shardName = `perf-shard-${shard.pid || 'browser'}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
  writeFileSync(join(artifactDir, shardName), JSON.stringify(shard, null, 2));
});
