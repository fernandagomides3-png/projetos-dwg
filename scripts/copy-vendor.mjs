// Copia o leitor DWG (LibreDWG compilado para WebAssembly) de node_modules para public/vendor,
// para que o site estático sirva os arquivos diretamente (sem depender de CDN).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mlightcad', 'libredwg-web');
const dest = join(root, 'public', 'vendor', 'libredwg');

if (!existsSync(src)) {
  console.error('Pacote @mlightcad/libredwg-web não encontrado. Rode "npm install" antes.');
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const dir of ['dist', 'wasm']) {
  cpSync(join(src, dir), join(dest, dir), {
    recursive: true,
    filter: (p) => !p.endsWith('.d.ts') && !p.endsWith('.cjs'),
  });
}
console.log('libredwg-web copiado para public/vendor/libredwg');
