import { spawnSync } from 'node:child_process';
for (const count of [10000, 100000, 1000000]) {
  for (const shape of ['balanced', 'unbalanced']) {
    const result = spawnSync(process.execPath, ['pipeline/benchmark.ts', String(count), shape], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
