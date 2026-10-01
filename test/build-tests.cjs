#!/usr/bin/env node
/**
 * 极简测试构建：用 rolldown（已随 vite 工具链安装，原生支持 TS）
 * 把每个 test/*.ts 打成独立的单文件 CommonJS 输出到 .test-build/test，
 * src/session 被内联进 bundle。随后由 `node --test` 执行。
 */
const path = require('node:path');
const fs = require('node:fs');
const { rolldown } = require('rolldown');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.test-build', 'test');
fs.rmSync(path.join(root, '.test-build'), { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

async function main() {
  const testDir = path.join(root, 'test');
  const entries = fs
    .readdirSync(testDir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => path.join(testDir, f));

  for (const input of entries) {
    const bundle = await rolldown({
      input,
      platform: 'node',
      shimMissingExports: false,
      resolve: {
        extensions: ['.ts', '.js', '.cjs', '.json'],
      },
    });
    const { output } = await bundle.generate({
      format: 'cjs',
      entryFileNames: '[name].cjs',
    });
    for (const chunk of output) {
      fs.writeFileSync(path.join(outDir, chunk.fileName), chunk.code);
    }
    await bundle.close();
  }
  console.log(`bundled ${entries.length} test files -> .test-build/test`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
