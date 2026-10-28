// Runs inside the offscreen document (an extension page) and hosts the
// on-device OCR engine: PaddleOCR's PP-OCRv6 "tiny" models executed by
// ONNX Runtime Web (WebAssembly). Nothing leaves the device.
//
// The message contract with background.js / content.js is unchanged from the
// previous engine: 'ocrEnsureReady' warms the models up, and 'ocrRecognize'
// takes an image data URL and answers { text, confidence } (confidence 0-100).

const MODEL_DIR = 'ocr/models/';
let enginePromise = null;

function extensionUrl(path) {
  return chrome.runtime.getURL(path);
}

async function fetchBytes(path) {
  const response = await fetch(extensionUrl(path));
  if (!response.ok) throw new Error('Missing OCR file: ' + path);
  return new Uint8Array(await response.arrayBuffer());
}

function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      if (!self.ort || !self.PPOCR) throw new Error('The bundled OCR engine did not load.');
      // Single-threaded WASM: multi-threading needs cross-origin isolation,
      // which extension pages don't have by default.
      self.ort.env.wasm.numThreads = 1;
      self.ort.env.wasm.proxy = false;
      self.ort.env.wasm.wasmPaths = {
        mjs: extensionUrl('ocr/ort/ort-wasm-simd-threaded.mjs'),
        wasm: extensionUrl('ocr/ort/ort-wasm-simd-threaded.wasm')
      };
      const [detModel, recModel, dictionaryText] = await Promise.all([
        fetchBytes(MODEL_DIR + 'PP-OCRv6_tiny_det.onnx'),
        fetchBytes(MODEL_DIR + 'PP-OCRv6_tiny_rec.onnx'),
        fetch(extensionUrl(MODEL_DIR + 'ppocrv6_tiny_dict.txt')).then((r) => r.text())
      ]);
      return self.PPOCR.createEngine({ ort: self.ort, detModel, recModel, dictionaryText });
    })().catch((error) => {
      enginePromise = null; // allow a retry on the next request
      throw error;
    });
  }
  return enginePromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'imdbLensOffscreen') return false;

  if (msg.action === 'ocrEnsureReady') {
    (async () => {
      try {
        await getEngine();
        sendResponse({ ready: true });
      } catch (error) {
        sendResponse({ error: error.message || 'Failed to load the OCR engine.' });
      }
    })();
    return true;
  }

  if (msg.action === 'ocrRecognize') {
    (async () => {
      try {
        const engine = await getEngine();
        const result = await engine.recognize(msg.imageDataUrl);
        sendResponse({ text: result.text || '', confidence: Number(result.confidence) || 0 });
      } catch (error) {
        sendResponse({ error: error.message || 'OCR failed' });
      }
    })();
    return true; // keep the message channel open for the async response
  }

  return false;
});
