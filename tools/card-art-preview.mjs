/**
 * 把人头牌渲染成「字符画」打印到终端，用来在没有图形界面的情况下检查牌面结构。
 * 同时给出 180° 旋转对称误差——传统扑克牌必须是双头对称的。
 *
 * 用法：node tools/card-art-preview.mjs [url] [S13,H12,C11,D1,...]
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.USERPROFILE}\\.agent-browser\\browsers\\chrome-154.0.8037.57\\chrome.exe`;
const PORT = Number(process.env.CDP_PORT ?? 9344);
const PAGE_URL = process.argv[2] ?? 'http://127.0.0.1:4173/';
/** 输入形如 S13 / H12 / C11 / D1，转成实际的纹理键 card_S_13 */
const CARDS = (process.argv[3] ?? 'S13,H12,C11,S7,S1')
  .split(',')
  .map((raw) => {
    const spec = raw.trim().toUpperCase();
    const suit = spec[0];
    const rank = spec.slice(1);
    return { key: `card_${suit}_${rank}`, label: spec };
  });

async function waitForJson(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* 等待浏览器就绪 */
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
      }, 20000);
    });
  }
}

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=.playtest/chrome-profile-art',
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    '--window-size=1280,800',
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
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await delay(1500);

  const result = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const keys = ${JSON.stringify(CARDS.map((c) => c.key))};
      const textures = window.__spider.phaser.textures;
      const out = {};
      const classify = (r, g, b, a) => {
        if (a < 16) return ' ';
        const sum = r + g + b;
        if (sum < 200) return '#';
        if (r > 240 && g > 232 && b > 220) return '.';
        if (r > 150 && r > g + 55 && r > b + 45) return 'r';
        if (r > 185 && g > 145 && b < 150) return 'y';
        if (b > r + 25 && b > 110) return 'b';
        if (g > r + 20 && g > b + 10) return 'g';
        if (r > 220 && g > 185 && b > 145) return 's';
        return '+';
      };
      for (const key of keys) {
        const texture = textures.get(key);
        if (!texture) { out[key] = { error: 'missing' }; continue; }
        const source = texture.getSourceImage();
        const w = source.width;
        const h = source.height;
        const ctx = source.getContext('2d');
        const data = ctx.getImageData(0, 0, w, h).data;
        const cellW = 4;
        const cellH = 8;
        const cols = Math.floor(w / cellW);
        const rows = Math.floor(h / cellH);
        const lines = [];
        for (let ry = 0; ry < rows; ry += 1) {
          let line = '';
          for (let rx = 0; rx < cols; rx += 1) {
            const counts = {};
            for (let y = ry * cellH; y < (ry + 1) * cellH; y += 1) {
              for (let x = rx * cellW; x < (rx + 1) * cellW; x += 1) {
                const i = (y * w + x) * 4;
                const c = classify(data[i], data[i + 1], data[i + 2], data[i + 3]);
                counts[c] = (counts[c] ?? 0) + 1;
              }
            }
            const total = cellW * cellH;
            if ((counts['#'] ?? 0) / total > 0.22) { line += '#'; continue; }
            let best = ' ';
            let bestCount = -1;
            for (const [c, n] of Object.entries(counts)) {
              if (n > bestCount) { bestCount = n; best = c; }
            }
            line += best;
          }
          lines.push(line.replace(/\\s+$/, ''));
        }
        // 180° 旋转对称误差（只看卡片内部，避开投影）
        let diff = 0;
        let samples = 0;
        for (let y = 14; y < h - 14; y += 2) {
          for (let x = 14; x < w - 14; x += 2) {
            const a = (y * w + x) * 4;
            const b = ((h - 1 - y) * w + (w - 1 - x)) * 4;
            diff += Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]);
            samples += 1;
          }
        }
        // 中央图案的墨迹包围盒（用来确认 A 的大花色真的居中）
        let minX = w;
        let maxX = -1;
        let minY = h;
        let maxY = -1;
        for (let y = 45; y < h - 45; y += 1) {
          for (let x = 45; x < w - 45; x += 1) {
            const i = (y * w + x) * 4;
            if (data[i] + data[i + 1] + data[i + 2] < 640) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        out[key] = {
          w,
          h,
          symmetry: +(diff / samples / 3).toFixed(2),
          ink: { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 },
          lines,
        };
      }
      return out;
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (result.exceptionDetails) {
    throw new Error(`页面执行失败：${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
  }
  const value = result.result.value;
  for (const { key, label } of CARDS) {
    const card = value[key];
    console.log(
      `\n=== ${label}  (180° 对称误差 ${card.symmetry}, ${card.w}x${card.h}) ink 中心 (${card.ink.cx.toFixed(1)}, ${card.ink.cy.toFixed(1)}) 目标 (${(card.w / 2).toFixed(1)}, ${(card.h / 2).toFixed(1)}) ===`,
    );
    console.log('    ' + '-'.repeat(Math.min(54, card.lines[0].length)));
    card.lines.forEach((line) => console.log('    ' + line));
    console.log('    ' + '-'.repeat(Math.min(54, card.lines[0].length)));
  }
  await cdp.send('Browser.close');
} catch (error) {
  console.error(error);
} finally {
  chrome.kill();
}
