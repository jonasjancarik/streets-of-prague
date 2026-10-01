// Build only the mail Worker; never replace the game's Build Output.
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] || '/tmp/streets-mail-build');
const output = `${root}/.cloudflare/output/v0`;
await mkdir(`${output}/workers/default/bundle`, { recursive: true });
await copyFile(new URL('../worker/mail.js', import.meta.url), `${output}/workers/default/bundle/index.js`);
await writeFile(`${output}/config.json`, JSON.stringify({
  accountId: '7756b12931ecfb3900a31049e157d706', buildContext: { isPreview: false },
}));
await writeFile(`${output}/workers/default/worker.config.json`, JSON.stringify({
  name: 'streets-of-prague-mail', compatibilityDate: '2026-10-01', workersDev: false,
  manifest: { type: 'partial', mainModule: 'index.js', modules: {} },
  observability: { enabled: true, headSamplingRate: 1 },
  env: {
    MAIL_ARCHIVE: { type: 'r2', name: 'streets-of-prague-mail' },
    FORWARD_TO: { type: 'text', value: 'jonas.jancarik@gmail.com' },
  },
}));
console.log(`Mail Worker Build Output: ${root}`);
