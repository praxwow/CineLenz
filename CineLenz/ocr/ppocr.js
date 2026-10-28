// CineLenz — on-device OCR engine built on PaddleOCR's PP-OCRv6 "tiny" models,
// run through ONNX Runtime Web (WebAssembly, CPU, single thread).
//
//   image ──► text detector (DB) ──► line boxes ──► text recognizer (CTC) ──► text
//
// This file is environment-agnostic: the caller injects the ONNX Runtime object,
// the model bytes and a tiny canvas adapter. In the extension that is the
// offscreen page; the same code is exercised in Node by the test-suite.
(function (root) {
  'use strict';

  // ── Tunables (PaddleOCR defaults, validated against these exact models) ──
  const DET_LONG_SIDE = 960;   // detector works on a ~960px longest side
  const DET_THRESH = 0.3;      // probability-map binarisation threshold
  const BOX_THRESH = 0.6;      // minimum mean probability for a region to count as text
  const UNCLIP_RATIO = 1.5;    // DB shrinks text kernels; grow the box back out
  const MIN_COMPONENT_AREA = 8;
  const REC_HEIGHT = 48;       // recognizer input height
  const REC_MIN_WIDTH = 16;
  const REC_MAX_WIDTH = 2000;
  const MIN_LINE_CONF = 0.4;   // drop recognised lines the model itself is unsure about
  const MAX_BOXES = 24;        // cluttered artwork can yield dozens of regions; titles are the biggest
  const TIME_BUDGET_MS = 10000; // stop reading extra lines after this (always keeps what's done)
  const RUN_TIMEOUT_MS = 20000; // hard stop: report which stage stalled instead of hanging forever
  const DET_MEAN = [0.485, 0.456, 0.406];
  const DET_STD = [0.229, 0.224, 0.225];

  // ── Canvas adapter (browser default) ──
  const browserCanvas = {
    create(width, height) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    // createImageBitmap does not depend on the page being rendered, unlike
    // <img>.decode() — the offscreen document that hosts OCR is never visible.
    async load(dataUrl) {
      const comma = dataUrl.indexOf(',');
      const mime = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
      const binary = atob(dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return createImageBitmap(new Blob([bytes], { type: mime }));
    }
  };

  function ctx2d(canvas) {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    return context;
  }

  // Both models were trained on BGR input, so channels are fed as B, G, R.
  function toTensorBGR(imageData, width, height, mean, std) {
    const plane = width * height;
    const out = new Float32Array(3 * plane);
    const px = imageData.data;
    for (let i = 0, p = 0; i < plane; i += 1, p += 4) {
      out[i] = (px[p + 2] / 255 - mean[0]) / std[0];
      out[plane + i] = (px[p + 1] / 255 - mean[1]) / std[1];
      out[2 * plane + i] = (px[p] / 255 - mean[2]) / std[2];
    }
    return out;
  }

  // Connected components (8-connectivity) over the thresholded probability map.
  // Returns one record per region with its bounding rect and mean probability.
  function findRegions(prob, width, height) {
    const total = width * height;
    const visited = new Uint8Array(total);
    const stack = new Int32Array(total);
    const regions = [];
    for (let start = 0; start < total; start += 1) {
      if (visited[start] || prob[start] <= DET_THRESH) continue;
      let top = 0;
      stack[top++] = start;
      visited[start] = 1;
      let minX = width, minY = height, maxX = 0, maxY = 0, count = 0, sum = 0;
      while (top > 0) {
        const idx = stack[--top];
        const y = (idx / width) | 0;
        const x = idx - y * width;
        count += 1;
        sum += prob[idx];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const n = ny * width + nx;
            if (!visited[n] && prob[n] > DET_THRESH) {
              visited[n] = 1;
              stack[top++] = n;
            }
          }
        }
      }
      if (count < MIN_COMPONENT_AREA) continue;
      regions.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, score: sum / count });
    }
    return regions;
  }

  // Stylised titles sometimes lose their word gaps ("StarWars", "TheDarkKnight").
  // Title-case words always start with a capital, so a capital that follows two
  // or more lowercase letters is a missing space. (Leaves "McFarland"/"DiCaprio" alone.)
  function restoreWordGaps(text) {
    return text.replace(/([a-z]{2})(?=[A-Z])/g, '$1 ');
  }

  // Group boxes into reading-order lines (top to bottom, left to right).
  function groupIntoLines(boxes) {
    const sorted = boxes.slice().sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const lines = [];
    for (const box of sorted) {
      const cy = (box.y0 + box.y1) / 2;
      const height = box.y1 - box.y0;
      const line = lines.find((l) => Math.abs(cy - l.cy) < 0.5 * Math.max(height, l.height));
      if (line) {
        line.boxes.push(box);
        line.cy = (line.cy * (line.boxes.length - 1) + cy) / line.boxes.length;
        line.height = Math.max(line.height, height);
      } else {
        lines.push({ cy, height, boxes: [box] });
      }
    }
    lines.forEach((l) => l.boxes.sort((a, b) => a.x0 - b.x0));
    return lines;
  }

  async function createEngine(options) {
    const { ort, detModel, recModel, dictionaryText } = options;
    const canvasApi = options.canvas || browserCanvas;

    // Dictionary layout: line 0 is the CTC blank slot; the model's last class is a space.
    const rawLines = dictionaryText.split('\n');
    if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
    const charset = [''].concat(rawLines.slice(1), [' ']);

    const sessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const detSession = await ort.InferenceSession.create(detModel, sessionOptions);
    const recSession = await ort.InferenceSession.create(recModel, sessionOptions);
    const detOut = detSession.outputNames[0];
    const recOut = recSession.outputNames[0];

    async function detect(source, srcW, srcH) {
      const scale = DET_LONG_SIDE / Math.max(srcW, srcH);
      const workW = Math.max(32, Math.round((srcW * scale) / 32) * 32);
      const workH = Math.max(32, Math.round((srcH * scale) / 32) * 32);
      const work = canvasApi.create(workW, workH);
      const context = ctx2d(work);
      context.drawImage(source, 0, 0, workW, workH);
      const input = toTensorBGR(context.getImageData(0, 0, workW, workH), workW, workH, DET_MEAN, DET_STD);
      const result = await detSession.run({ x: new ort.Tensor('float32', input, [1, 3, workH, workW]) });
      const prob = result[detOut].data;
      const sx = srcW / workW;
      const sy = srcH / workH;
      const boxes = [];
      for (const r of findRegions(prob, workW, workH)) {
        if (r.score < BOX_THRESH) continue;
        const grow = (r.w * r.h * UNCLIP_RATIO) / (2 * (r.w + r.h));
        boxes.push({
          x0: Math.max(0, Math.floor((r.x - grow) * sx)),
          y0: Math.max(0, Math.floor((r.y - grow) * sy)),
          x1: Math.min(srcW, Math.ceil((r.x + r.w + grow) * sx)),
          y1: Math.min(srcH, Math.ceil((r.y + r.h + grow) * sy)),
          score: r.score
        });
      }
      return boxes.filter((b) => b.x1 - b.x0 >= 4 && b.y1 - b.y0 >= 4);
    }

    async function recognizeCrop(source, box) {
      let cw = box.x1 - box.x0;
      let ch = box.y1 - box.y0;
      let crop = canvasApi.create(cw, ch);
      ctx2d(crop).drawImage(source, box.x0, box.y0, cw, ch, 0, 0, cw, ch);
      if (ch > cw * 1.5) { // vertical text: rotate 90° counter-clockwise
        const rotated = canvasApi.create(ch, cw);
        const rctx = ctx2d(rotated);
        rctx.translate(0, cw);
        rctx.rotate(-Math.PI / 2);
        rctx.drawImage(crop, 0, 0);
        crop = rotated;
        [cw, ch] = [ch, cw];
      }
      const width = Math.min(REC_MAX_WIDTH, Math.max(REC_MIN_WIDTH, Math.ceil((REC_HEIGHT * cw) / ch)));
      const strip = canvasApi.create(width, REC_HEIGHT);
      const sctx = ctx2d(strip);
      sctx.drawImage(crop, 0, 0, cw, ch, 0, 0, width, REC_HEIGHT);
      const input = toTensorBGR(sctx.getImageData(0, 0, width, REC_HEIGHT), width, REC_HEIGHT, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
      const result = await recSession.run({ x: new ort.Tensor('float32', input, [1, 3, REC_HEIGHT, width]) });
      const out = result[recOut];
      const steps = out.dims[1];
      const classes = out.dims[2];
      const data = out.data;
      let text = '';
      let confSum = 0;
      let confCount = 0;
      let previous = -1;
      for (let t = 0; t < steps; t += 1) {
        let best = 0;
        let bestValue = data[t * classes];
        for (let c = 1; c < classes; c += 1) {
          const v = data[t * classes + c];
          if (v > bestValue) { bestValue = v; best = c; }
        }
        if (best !== 0 && best !== previous) {
          text += charset[best] || '';
          confSum += bestValue;
          confCount += 1;
        }
        previous = best;
      }
      return { text, confidence: confCount ? confSum / confCount : 0 };
    }

    // Public: recognise all text in an image (data URL). Calls are serialised.
    let queue = Promise.resolve();
    function recognize(dataUrl) {
      const progress = { stage: 'starting' };
      const job = queue.then(() => withWatchdog(run(dataUrl, progress), progress));
      queue = job.catch(() => {});
      return job;
    }

    function withWatchdog(promise, progress) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('OCR timed out while ' + progress.stage + '.')), RUN_TIMEOUT_MS);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    async function run(dataUrl, progress) {
      const startedAt = Date.now();
      progress.stage = 'decoding the image';
      const image = await canvasApi.load(dataUrl);
      const srcW = image.naturalWidth || image.width;
      const srcH = image.naturalHeight || image.height;
      const source = canvasApi.create(srcW, srcH);
      ctx2d(source).drawImage(image, 0, 0);

      progress.stage = 'finding text regions';
      let boxes = await detect(source, srcW, srcH);
      if (boxes.length > MAX_BOXES) {
        // keep the largest regions: the title is almost always the biggest text
        boxes.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
        boxes = boxes.slice(0, MAX_BOXES);
      }
      // A tight crop around a single title can leave the detector with no
      // margin to work with — fall back to reading the whole image as a line.
      if (!boxes.length) boxes = [{ x0: 0, y0: 0, x1: srcW, y1: srcH, score: 0 }];

      progress.stage = 'reading the text';
      const lines = [];
      // Biggest text first, so the time budget can only ever cut small print.
      const groups = groupIntoLines(boxes).sort((a, b) => b.height - a.height);
      for (const line of groups) {
        if (lines.length && Date.now() - startedAt > TIME_BUDGET_MS) break;
        const parts = [];
        let confSum = 0;
        for (const box of line.boxes) {
          const r = await recognizeCrop(source, box);
          if (r.text.trim()) { parts.push(restoreWordGaps(r.text.trim())); confSum += r.confidence; }
        }
        if (!parts.length) continue;
        const confidence = confSum / parts.length;
        if (confidence >= MIN_LINE_CONF) lines.push({ text: parts.join(' '), confidence, cy: line.cy });
      }
      lines.sort((a, b) => a.cy - b.cy); // back to reading order, top to bottom
      const overall = lines.length ? lines.reduce((s, l) => s + l.confidence, 0) / lines.length : 0;
      return { text: lines.map((l) => l.text).join('\n'), confidence: overall * 100, lines };
    }

    return { recognize };
  }

  const api = { createEngine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PPOCR = api;
})(typeof self !== 'undefined' ? self : globalThis);
