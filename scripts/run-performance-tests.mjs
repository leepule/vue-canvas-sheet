import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = join(root, 'tests/performance/.artifacts');
const reportPath = join(artifactDir, 'perf-report.json');
const vitestBin = join(root, 'node_modules/vitest/vitest.mjs');

rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(artifactDir, { recursive: true });

const args = [
  vitestBin,
  'run',
  'tests/performance',
  '--reporter=dot',
  '--fileParallelism=false',
  ...process.argv.slice(2)
];

const exitCode = await new Promise((resolveExit) => {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      PERF_ARTIFACT_DIR: artifactDir,
      VITEST_SETUP_SILENT: '1'
    }
  });

  child.on('close', code => resolveExit(code ?? 1));
  child.on('error', () => resolveExit(1));
});

const shards = existsSync(artifactDir)
  ? Array.from(new Set(
      readdirSync(artifactDir)
        .filter(name => name.startsWith('perf-shard-') && name.endsWith('.json'))
    ))
  : [];

const metrics = [];
for (const shardName of shards) {
  const shard = JSON.parse(readFileSync(join(artifactDir, shardName), 'utf8'));
  metrics.push(...(shard.metrics || []));
}

metrics.sort((a, b) => a.name.localeCompare(b.name));

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ci: process.env.CI === 'true'
  },
  summary: {
    total: metrics.length,
    passed: metrics.filter(metric => metric.pass).length,
    failed: metrics.filter(metric => !metric.pass).length
  },
  metrics
};

writeFileSync(reportPath, JSON.stringify(report, null, 2));
process.stdout.write(`Performance report written to ${reportPath}\n`);

process.exit(exitCode);
