/**
 * 图集体检：检查每张牌是否非空、上下是否对称（传统人头牌是双头的）、
 * 以及红黑花色是否排在正确的行上。
 * 用法：node tools/deck-check.mjs [atlasUrl]
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.USERPROFILE}\\.agent-browser\\browsers\\chrome-154.0.8037.57\\chrome.exe`;
const PORT = Number(process.env.CDP_PORT ?? 9366);
const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:5173';
const ATLAS = process.argv[2] ?? '/assets/cards/atlas.png';

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
    '--user-data-dir=.playtest/chrome-profile-deck',
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
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
  await cdp.send('Page.navigate', { url: ORIGIN + '/' });
  await delay(1200);

  const res = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图集加载失败'));
        img.src = ${JSON.stringify(ATLAS)};
      });
      const CELL_W = 200, CELL_H = 277, COLS = 13;
      const ROWS = { S: 0, H: 1, D: 2, C: 3 };
      const canvas = document.createElement('canvas');
      canvas.width = CELL_W;
      canvas.height = CELL_H;
      const ctx = canvas.getContext('2d');
      const out = [];
      for (const suit of ['S', 'H', 'D', 'C']) {
        for (let rank = 1; rank <= 13; rank += 1) {
          ctx.clearRect(0, 0, CELL_W, CELL_H);
          ctx.drawImage(image, (rank - 1) * CELL_W, ROWS[suit] * CELL_H, CELL_W, CELL_H, 0, 0, CELL_W, CELL_H);
          const data = ctx.getImageData(0, 0, CELL_W, CELL_H).data;
          // 牌面本身在格子里是 194x269（右侧/底部留了投影余量），
          // 所以必须绕「牌面中心」镜像，而不是绕格子中心。
          const CARD_W = 194;
          const CARD_H = 269;
          let diff = 0, samples = 0, ink = 0, red = 0, black = 0;
          for (let y = 2; y < CARD_H - 2; y += 1) {
            for (let x = 2; x < CARD_W - 2; x += 1) {
              const i = (y * CELL_W + x) * 4;
              const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
              if (a > 100 && r + g + b < 600) {
                ink += 1;
                if (r > g + 50 && r > b + 50) red += 1;
                else if (r < 110 && g < 110 && b < 110) black += 1;
              }
              if (x % 2 === 0 && y % 2 === 0) {
                const j = ((CARD_H - 1 - y) * CELL_W + (CARD_W - 1 - x)) * 4;
                diff += Math.abs(r - data[j]) + Math.abs(g - data[j + 1]) + Math.abs(b - data[j + 2]);
                samples += 1;
              }
            }
          }
          out.push({
            key: suit + rank,
            symmetry: +(diff / samples / 3).toFixed(1),
            ink: +(ink / ((CARD_W - 4) * (CARD_H - 4))).toFixed(3),
            redRatio: ink ? +(red / ink).toFixed(2) : 0,
            blackRatio: ink ? +(black / ink).toFixed(2) : 0,
          });
        }
      }
      return { size: [image.naturalWidth, image.naturalHeight], cards: out };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  const { size, cards } = res.result.value;
  console.log(`图集 ${ATLAS} ${size[0]}x${size[1]}`);
  console.log('牌   对称误差  墨量   红色占比 黑色占比');
  for (const c of cards) {
    console.log(
      `${c.key.padEnd(4)} ${String(c.symmetry).padStart(7)}  ${String(c.ink).padStart(6)}  ${String(c.redRatio).padStart(6)}  ${String(c.blackRatio).padStart(6)}`,
    );
  }
  const courts = cards.filter((c) => /1[123]$/.test(c.key));
  const worst = courts.sort((a, b) => b.symmetry - a.symmetry)[0];
  console.log(`\n人头牌最大对称误差：${worst.key} = ${worst.symmetry}`);
  const blanks = cards.filter((c) => c.ink < 0.02);
  console.log(`空白牌：${blanks.length ? blanks.map((c) => c.key).join(',') : '无'}`);
  await cdp.send('Browser.close');
} catch (error) {
  console.error(error);
} finally {
  chrome.kill();
}
