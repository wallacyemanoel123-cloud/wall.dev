// Recibos: compressão da imagem e OCR GRATUITO executado no próprio aparelho (Tesseract.js).
// Os arquivos do OCR são servidos pelo próprio site (public/vendor, gerado no build); a imagem
// não é enviada a nenhum serviço de terceiros. Só o arquivo comprimido vai para o seu banco.
const VENDOR = '/vendor/tesseract/';

export async function prepareFile(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 1_400_000) throw new Error('PDF maior que 1,4 MB. Envie uma foto ou screenshot.');
    return { mime: 'application/pdf', b64: await toB64(file), blob: file, preview: null };
  }
  if (!file.type.startsWith('image/')) throw new Error('Envie uma imagem (foto/screenshot) ou PDF.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let quality = 0.82, blob;
  do { blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality)); quality -= 0.12; } while (blob.size > 1_300_000 && quality > 0.3);
  if (blob.size > 1_400_000) throw new Error('Imagem muito grande mesmo após compressão.');
  return { mime: 'image/jpeg', b64: await toB64(blob), blob, preview: URL.createObjectURL(blob) };
}

function toB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    r.readAsDataURL(blob);
  });
}

let loading;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = VENDOR + 'tesseract.min.js';
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { loading = null; reject(new Error('Não foi possível carregar o leitor de texto.')); };
    document.head.appendChild(s);
  });
  return loading;
}

export async function readText(blob, onProgress) {
  const T = await loadTesseract();
  const worker = await T.createWorker(['por', 'eng'], 1, {
    workerPath: VENDOR + 'worker.min.js', corePath: VENDOR + 'core/', langPath: VENDOR + 'lang', workerBlobURL: false,
    logger: m => m.status === 'recognizing text' && onProgress?.(Math.round(m.progress * 100)),
  });
  try { return (await worker.recognize(blob)).data.text; } finally { await worker.terminate(); }
}
