/**
 * 把任意 PNG 变成终端字符画，用来在没有图形界面时核对素材长相。
 * 用法：node tools/image-ascii.mjs <图片URL> [列数]
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.USERPROFILE}\\.agent-browser\\browsers\\chrome-154.0.8037.57\\chrome.exe`;
const PORT = Number(process.env.CDP_PORT ?? 9355);
const URL_ARG = process.argv[2];
const COLS = Number(process.argv[3] ?? 56);

if (!URL_ARG) {
  console.error('用法：node tools/image-ascii.mjs <图片URL> [列数]');
  process.exit(1);
}

async function waitForJson(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* 等浏览器起来 */
    }
    await delay(200);
  }
  throw new Error(`等待 ${url} 超时`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 25000);
    });
  }
}

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=.playtest/chrome-profile-ascii',
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--allow-file-access-from-files',
    '--force-device-scale-factor=1',
    '--window-size=800,600',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  await waitForJson(`http://127.0.0.1:${PORT}/json/version`);
  const targets = await waitForJson(`http://127.0.0.1:${PORT}/json/list`);
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // 直接导航到图片：这样画布和图片同源，可以读像素
  await cdp.send('Page.navigate', { url: URL_ARG });
  await delay(1200);

  const result = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const image = document.querySelector('img');
      if (!image) throw new Error('页面里没有 img（是不是导航失败？）');
      if (!image.complete) {
        await new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); });
      }
      const canvas = document.createElement('canvas');
      const CROP = ${JSON.stringify(process.argv[5] ?? '')};
      const crop = CROP
        ? CROP.split(',').map(Number)
        : [0, 0, 1, 1];
      const srcX = Math.round(crop[0] * image.naturalWidth);
      const srcY = Math.round(crop[1] * image.naturalHeight);
      const srcW = Math.max(1, Math.round((crop[2] - crop[0]) * image.naturalWidth));
      const srcH = Math.max(1, Math.round((crop[3] - crop[1]) * image.naturalHeight));
      canvas.width = srcW;
      canvas.height = srcH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const cellW = Math.max(1, Math.floor(canvas.width / ${COLS}));
      const cellH = cellW * 2;
      const cols = Math.floor(canvas.width / cellW);
      const rows = Math.floor(canvas.height / cellH);
      const MODE = ${JSON.stringify(process.argv[4] ?? 'lum')};
      const ramp = ' .:-=+*#%@';
      const classify = (r, g, b) => {
        if (MODE === 'lum') {
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          return ramp[Math.min(ramp.length - 1, Math.round((1 - lum) * (ramp.length - 1)))];
        }
        const sum = r + g + b;
        if (sum < 210) return '#';
        if (r > 150 && r > g + 55 && r > b + 45) return 'r';
        if (r > 185 && g > 145 && b < 155) return 'y';
        if (b > r + 25 && b > 110) return 'b';
        if (g > r + 18 && g > b + 10) return 'g';
        if (sum < 640) return '+';
        return '.';
      };
      const lines = [];
      for (let ry = 0; ry < rows; ry += 1) {
        let line = '';
        for (let rx = 0; rx < cols; rx += 1) {
          const counts = {};
          for (let y = ry * cellH; y < Math.min(canvas.height, (ry + 1) * cellH); y += 1) {
            for (let x = rx * cellW; x < Math.min(canvas.width, (rx + 1) * cellW); x += 1) {
              const i = (y * canvas.width + x) * 4;
              const c = classify(data[i], data[i + 1], data[i + 2]);
              counts[c] = (counts[c] ?? 0) + 1;
            }
          }
          const blank = MODE === 'lum' ? ' ' : '.';
          let best = blank;
          let bestCount = -1;
          for (const [c, n] of Object.entries(counts)) {
            if (c === blank) continue;
            if (n > bestCount) { bestCount = n; best = c; }
          }
          line += best;
        }
        lines.push(line);
      }
      const stats = { transparent: 0, total: 0, samples: [] };
      for (let i = 0; i < data.length; i += 4) {
        stats.total += 1;
        if (data[i + 3] < 16) stats.transparent += 1;
      }
      const sample = (x, y) => {
        const i = (Math.round(y) * canvas.width + Math.round(x)) * 4;
        return [data[i], data[i + 1], data[i + 2], data[i + 3]];
      };
      stats.samples = [
        ['左上角', sample(canvas.width * 0.06, canvas.height * 0.05)],
        ['卡片中心', sample(canvas.width * 0.5, canvas.height * 0.5)],
        ['面板中心', sample(canvas.width * 0.42, canvas.height * 0.4)],
        ['右上空白', sample(canvas.width * 0.9, canvas.height * 0.12)],
        ['底部中点', sample(canvas.width * 0.5, canvas.height * 0.95)],
      ];
      stats.transparentRatio = +(stats.transparent / stats.total).toFixed(3);
      return { w: canvas.width, h: canvas.height, lines, stats };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  const { w, h, lines, stats } = result.result.value;
  console.log(`\n=== ${URL_ARG} (${w}x${h}) ===`);
  lines.forEach((line) => console.log(line));
  console.log(`透明像素占比 ${stats.transparentRatio}`);
  for (const [label, rgba] of stats.samples) console.log(`  ${label}: rgba(${rgba.join(',')})`);
  await cdp.send('Browser.close');
} catch (error) {
  console.error(error);
} finally {
  chrome.kill();
}
