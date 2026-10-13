// Copia o leitor de texto (Tesseract.js) e os idiomas português/inglês para public/vendor/,
// para o OCR rodar 100% a partir do seu próprio domínio (sem CDN de terceiros).
// Roda automaticamente no build/deploy (npm run build). A pasta gerada não vai para o Git.
import { mkdir, copyFile } from 'node:fs/promises';

const nm = new URL('../node_modules/', import.meta.url), out = new URL('../public/vendor/tesseract/', import.meta.url);
const files = [
  ['tesseract.js/dist/tesseract.min.js', 'tesseract.min.js'],
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'core/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'core/tesseract-core-lstm.wasm.js'],
  ['@tesseract.js-data/por/4.0.0_best_int/por.traineddata.gz', 'lang/por.traineddata.gz'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata.gz'],
];
for (const dir of ['core/', 'lang/']) await mkdir(new URL(dir, out), { recursive: true });
for (const [from, to] of files) await copyFile(new URL(from, nm), new URL(to, out));
console.log('OCR copiado para public/vendor/tesseract/.');
