// Web Worker: lê o DWG/DXF com LibreDWG (WebAssembly) e monta a cena 2D,
// sem travar a interface.
import { LibreDwg, Dwg_File_Type } from '../vendor/libredwg/dist/libredwg-web.js';
import { buildScene } from './scene.js';

let libPromise = null;

function getLib() {
  if (!libPromise) {
    const wasmDir = new URL('../vendor/libredwg/wasm', import.meta.url).href;
    libPromise = LibreDwg.create(wasmDir).catch((err) => {
      libPromise = null;
      throw err;
    });
  }
  return libPromise;
}

const progress = (msg) => self.postMessage({ type: 'progress', msg });

self.onmessage = async (ev) => {
  const { name, buffer } = ev.data;
  try {
    progress('Carregando o leitor DWG (WebAssembly)…');
    const lib = await getLib();

    const bytes = new Uint8Array(buffer);
    const sig = String.fromCharCode(...bytes.subarray(0, 6));
    const isDwg = /^AC\d{4}$/.test(sig);
    if (!isDwg && !/\.dxf$/i.test(name)) {
      throw new Error('O arquivo não parece ser um DWG válido (assinatura "' + sig.replace(/[^\x20-\x7e]/g, '?') + '").');
    }

    progress('Lendo ' + (isDwg ? 'DWG' : 'DXF') + '…');
    const data = lib.dwg_read_data(buffer, isDwg ? Dwg_File_Type.DWG : Dwg_File_Type.DXF);
    if (!data) throw new Error('Não foi possível decodificar o arquivo.');

    progress('Convertendo entidades…');
    let db;
    try {
      db = lib.convert(data);
    } finally {
      lib.dwg_free(data);
    }

    progress('Montando a geometria e calculando áreas…');
    const scene = buildScene(db, {
      signature: isDwg ? sig : '',
      fileName: name,
      fileSize: bytes.length,
      format: isDwg ? 'DWG' : 'DXF',
    });
    self.postMessage({ type: 'result', scene });
  } catch (err) {
    // Após uma falha, o heap do WASM pode ficar inconsistente: recria na próxima leitura.
    libPromise = null;
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
