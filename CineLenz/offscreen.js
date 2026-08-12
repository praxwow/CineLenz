// Runs inside the offscreen document (an extension page). Unlike content.js,
// this page's origin IS chrome-extension://<id>, so Tesseract.js can
// construct its Worker directly instead of being blocked as cross-origin.
//
// OCR is English-only by design (single 'eng' language pack).

let ocrWorkerPromise = null;

function extensionUrl(path) {
  return chrome.runtime.getURL(path);
}

async function getOcrWorker() {
  if (!self.Tesseract) throw new Error('The bundled OCR engine did not load.');
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = self.Tesseract.createWorker('eng', 1, {
      workerPath: extensionUrl('vendor/worker.min.js'),
      corePath: extensionUrl('vendor'),
      langPath: extensionUrl('ocr-data'),
      workerBlobURL: false,
      cacheMethod: 'write'
    }).catch((error) => {
      ocrWorkerPromise = null;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'imdbLensOffscreen') return false;

  if (msg.action === 'ocrEnsureReady') {
    (async () => {
      try {
        await getOcrWorker();
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
        const worker = await getOcrWorker();
        await worker.setParameters({
          tessedit_pageseg_mode: msg.psm,
          preserve_interword_spaces: '1',
          user_defined_dpi: '300'
        });
        const { data } = await worker.recognize(msg.imageDataUrl);
        sendResponse({ text: data.text || '', confidence: Number(data.confidence) || 0 });
      } catch (error) {
        sendResponse({ error: error.message || 'OCR failed' });
      }
    })();
    return true; // keep the message channel open for the async response
  }

  return false;
});
