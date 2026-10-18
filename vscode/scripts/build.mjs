import { build, context } from 'esbuild';
const options = { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true,
  platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'], sourcemap: true };
if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
