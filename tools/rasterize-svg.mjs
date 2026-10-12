/**
 * 用无头浏览器把 SVG 渲染成指定尺寸的 PNG（PowerShell / System.Drawing 处理不了 SVG）。
 * 用法：node tools/rasterize-svg.mjs <svgUrl> <输出png> <宽> <高>
 * 说明：SVG 需要能通过 http 访问（放到 public/ 下即可），这样画布同源、能导出像素。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.USERPROFILE}\\.agent-browser\\browsers\\chrome-154.0.8037.57\\chrome.exe`;
const PORT = Number(process.env.CDP_PORT ?? 9377);
const [SVG_URL, OUT_FILE, WIDTH_ARG, HEIGHT_ARG] = process.argv.slice(2);

if (!SVG_URL || !OUT_FILE) {
  console.error('用法：node tools/rasterize-svg.mjs <svgUrl> <输出png> <宽> <高>');
  process.exit(1);
}

const width = Number(WIDTH_ARG ?? 0);
const height = Number(HEIGHT_ARG ?? 0);

async function waitForJson(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* 等浏览器 */
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
      }, 30000);
    });
  }
}

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=.playtest/chrome-profile-svg',
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1200,1400',
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
  // 先把页面导航到同一来源，否则画布会被判定为跨域、无法导出像素
  await cdp.send('Page.navigate', { url: new URL(SVG_URL).origin + '/' });
  await delay(1200);

  const res = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('SVG 加载失败'));
        img.src = ${JSON.stringify(SVG_URL)};
      });
      const w = ${width || 0} || image.naturalWidth;
      const h = ${height || 0} || image.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0, w, h);
      return { dataUrl: canvas.toDataURL('image/png'), w, h };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  }
  const { dataUrl, w, h } = res.result.value;
  if (!dataUrl?.startsWith('data:image/png')) throw new Error('导出失败：没有拿到 PNG 数据');
  writeFileSync(OUT_FILE, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`✔ 已生成 ${OUT_FILE}  ${w}x${h}`);
  await cdp.send('Browser.close');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
