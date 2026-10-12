/**
 * 用本地 Chromium + CDP 跑一遍真人视角的冒烟测试：
 * 打开页面 → 开局 → 点击选牌 → 拖动 → 发牌 → 撤销 → 提示 → 空列限制 → 通关 → 手机尺寸。
 * 每一步都会截图到 .playtest/shots，方便人工复核画面。
 *
 * 用法：node tools/playtest.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.USERPROFILE}\\.agent-browser\\browsers\\chrome-154.0.8037.57\\chrome.exe`;
const PORT = Number(process.env.CDP_PORT ?? 9333);
const PAGE_URL = process.argv[2] ?? 'http://127.0.0.1:4173/';
const SHOTS = '.playtest/shots';
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844, mobile: true, dpr: 3 };

mkdirSync(SHOTS, { recursive: true });

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const handler of this.listeners.get(msg.method) ?? []) handler(msg.params);
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

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
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

const results = [];
const consoleErrors = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await delay(200);
  }
  throw new Error(`等待 ${url} 超时`);
}

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=.playtest/chrome-profile',
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=Translate,BackForwardCache',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--mute-audio',
    `--window-size=${DESKTOP.width},${DESKTOP.height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let cdp;
let viewport = { ...DESKTOP };

try {
  const version = await waitForHttp(`http://127.0.0.1:${PORT}/json/version`);
  console.log(`Chromium: ${version.Browser}`);

  const targets = await waitForHttp(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有找到可用的页面 target');

  cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  // 关掉 HTTP 缓存：否则复用浏览器 profile 时会拿到上一次部署的旧页面，
  // 让人误以为线上没更新（GitHub Pages 的 HTML 有 10 分钟缓存）。
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  cdp.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails ?? {};
    consoleErrors.push(
      `${details.text ?? 'unknown'}: ${details.exception?.description ?? ''}`.trim(),
    );
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') {
      consoleErrors.push(params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  cdp.on('Log.entryAdded', (params) => {
    if (params.entry.level === 'error') consoleErrors.push(`${params.entry.text} ${params.entry.url ?? ''}`);
  });

  const setViewport = async (size) => {
    viewport = size;
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size.width,
      height: size.height,
      deviceScaleFactor: size.dpr ?? 1,
      mobile: Boolean(size.mobile),
    });
  };

  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`页面执行出错：${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
    }
    return res.result.value;
  };

  const shoot = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(shot.data, 'base64'));
  };

  const dispatch = (type, x, y, extra = {}) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });

  const click = async (x, y) => {
    await dispatch('mouseMoved', x, y, { buttons: 0 });
    await delay(30);
    await dispatch('mousePressed', x, y, { buttons: 1, clickCount: 1 });
    await delay(45);
    await dispatch('mouseReleased', x, y, { buttons: 0, clickCount: 1 });
    await delay(120);
  };

  const doubleClick = async (x, y) => {
    await click(x, y);
    await delay(60);
    await dispatch('mousePressed', x, y, { buttons: 1, clickCount: 2 });
    await delay(45);
    await dispatch('mouseReleased', x, y, { buttons: 0, clickCount: 2 });
    await delay(220);
  };

  const drag = async (from, to) => {
    await dispatch('mouseMoved', from.x, from.y, { buttons: 0 });
    await delay(30);
    await dispatch('mousePressed', from.x, from.y, { buttons: 1, clickCount: 1 });
    const steps = 10;
    for (let i = 1; i <= steps; i += 1) {
      await dispatch('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, {
        buttons: 1,
      });
      await delay(16);
    }
    await delay(80);
    await dispatch('mouseReleased', to.x, to.y, { buttons: 0, clickCount: 1 });
    await delay(260);
  };

  /** 页面内的坐标助手：把「第 col 列第 index 张牌」换算成视口坐标 */
  const pointFor = (col, index, kind = 'card') =>
    evaluate(`(() => {
      const s = window.__spider.scene;
      const st = window.__spider.state();
      const l = s.layout;
      const rect = document.querySelector('#stage canvas').getBoundingClientRect();
      // 画布是按设备像素渲染的：布局坐标要除以 dpr 才是 CSS 视口坐标
      const dpr = s.scale.width / s.scale.displaySize.width;
      const column = st.columns[${col}];
      let y = l.columnTopY;
      for (let i = 0; i < ${index}; i += 1) {
        y += column[i].faceUp ? l.fanUp : l.fanDown;
      }
      if (${JSON.stringify(kind)} === 'card') y += l.fanUp * 0.45;
      if (${JSON.stringify(kind)} === 'bottom') y = l.columnTopY + l.cardH / 2;
      return { x: rect.left + l.columnX[${col}] / dpr, y: rect.top + y / dpr };
    })()`);

  const stockPoint = () =>
    evaluate(`(() => {
      const s = window.__spider.scene;
      const l = s.layout;
      const dpr = s.scale.width / s.scale.displaySize.width;
      const rect = document.querySelector('#stage canvas').getBoundingClientRect();
      return {
        x: rect.left + (l.stock.x + l.stock.w / 2) / dpr,
        y: rect.top + (l.stock.y + l.stock.h / 2) / dpr,
      };
    })()`);

  /** 先取按钮位置，再发真实鼠标事件——和真人点击走同一条路径（也才会触发音频解锁） */
  const clickButton = async (text) => {
    const point = await evaluate(`(() => {
      const node = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}));
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!point) return false;
    await click(point.x, point.y);
    return true;
  };

  /**
   * 画面取样：用 Phaser 自己的 snapshot 读取真实渲染结果。
   * 只靠 DOM/几何断言看不出「牌面到底画出来没有」，所以这里直接看像素。
   */
  const samplePixels = () =>
    evaluate(`(async () => {
      const s = window.__spider.scene;
      const st = window.__spider.state();
      const l = s.layout;
      const renderer = window.__spider.phaser.renderer;
      const lastIndex = st.columns[0].length - 1;
      const faceY = l.columnTopY + (() => {
        let y = 0;
        for (let i = 0; i < lastIndex; i += 1) y += st.columns[0][i].faceUp ? l.fanUp : l.fanDown;
        return y;
      })();
      const regions = {
          // 取整张牌（含四角点数），这样哪怕是一张中间留白的 2 / A 也一定有墨
          face: { x: l.columnX[0] - l.cardW / 2, y: faceY, w: l.cardW, h: l.cardH },
        back: { x: l.stock.x + l.stock.w * 0.2, y: l.stock.y + l.stock.h * 0.2, w: l.stock.w * 0.6, h: l.stock.h * 0.6 },
        felt: { x: l.width * 0.4, y: l.stock.y + l.stock.h * 0.25, w: l.width * 0.15, h: l.stock.h * 0.5 },
      };
      const report = await new Promise((resolve) => {
        renderer.snapshot((image) => {
          const c = document.createElement('canvas');
          c.width = image.width;
          c.height = image.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(image, 0, 0);
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          const classify = (i) => {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            if (a < 16) return 'transparent';
            if (r > 200 && g > 190 && b > 165) return 'ivory';
            if (r > 120 && r > g + 40 && r > b + 40) return 'red';
            if (b > r + 25 && b > 110) return 'blue';
            if (r + g + b < 260) return 'dark';
            return 'other';
          };
          const scan = (region) => {
            const counts = { transparent: 0, ivory: 0, red: 0, blue: 0, dark: 0, other: 0, total: 0 };
            const x0 = Math.max(0, Math.round(region.x));
            const y0 = Math.max(0, Math.round(region.y));
            const x1 = Math.min(c.width, Math.round(region.x + region.w));
            const y1 = Math.min(c.height, Math.round(region.y + region.h));
            for (let y = y0; y < y1; y += 1) {
              for (let x = x0; x < x1; x += 1) {
                counts[classify((y * c.width + x) * 4)] += 1;
                counts.total += 1;
              }
            }
            const ratio = (key) => (counts.total ? +(counts[key] / counts.total).toFixed(3) : 0);
            return {
              total: counts.total,
              transparent: ratio('transparent'),
              ivory: ratio('ivory'),
              dark: ratio('dark'),
              red: ratio('red'),
              blue: ratio('blue'),
            };
          };
          const overall = { transparent: 0, ivory: 0, dark: 0, red: 0, blue: 0, other: 0 };
          for (let i = 0; i < data.length; i += 4) overall[classify(i)] += 1;
          const total = c.width * c.height;
          const metrics = {
            size: [c.width, c.height],
            transparent: +(overall.transparent / total).toFixed(3),
            ivory: +(overall.ivory / total).toFixed(3),
            dark: +(overall.dark / total).toFixed(3),
            red: +(overall.red / total).toFixed(3),
          };
          resolve({ regions: { face: scan(regions.face), back: scan(regions.back), felt: scan(regions.felt) }, metrics });
        });
      });
      report.profile = await new Promise((resolve) => {
        renderer.snapshot((image) => {
          const c = document.createElement('canvas');
          c.width = image.width;
          c.height = image.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(image, 0, 0);
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          const x = Math.round(l.columnX[0]);
          const bands = [];
          for (let y = 0; y < c.height; y += 40) {
            let opaque = 0;
            let light = 0;
            let count = 0;
            for (let yy = y; yy < Math.min(c.height, y + 40); yy += 1) {
              const i = (yy * c.width + x) * 4;
              count += 1;
              if (data[i + 3] > 200) opaque += 1;
              if (data[i] > 200 && data[i + 1] > 190) light += 1;
            }
            bands.push({ y, opaque: +(opaque / count).toFixed(2), light: +(light / count).toFixed(2) });
          }
          resolve({ x, bands, layout: { columnTopY: Math.round(l.columnTopY), cardH: Math.round(l.cardH), fanUp: Math.round(l.fanUp), fanDown: Math.round(l.fanDown), cardW: Math.round(l.cardW), col0: st.columns[0].length } });
        });
      });
      return report;
    })()`);

  const summarize = () =>
    evaluate(`(() => {
      const st = window.__spider.state();
      const onTable = st.columns.reduce((sum, c) => sum + c.length, 0);
      return {
        score: st.score,
        moves: st.moves,
        sets: st.sets.length,
        stock: st.stock.length,
        onTable,
        total: onTable + st.stock.reduce((s, g) => s + g.length, 0) + st.sets.length * 13,
        status: st.status,
        overlay: document.querySelectorAll('.overlay').length,
        toast: [...document.querySelectorAll('.toast')].pop()?.textContent ?? '',
        header: document.querySelector('.stat__value')?.textContent ?? '',
        hudText: [...document.querySelectorAll('.stat__value')].map((n) => n.textContent).join('|'),
        canvas: (() => { const c = document.querySelector('#stage canvas'); const r = c.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
        /**
         * 直接量卡牌精灵的实际包围盒，而不是按布局公式推算：
         * 这样「原点用错导致整列偏移」这类 bug 才会被发现。
         */
        overflow: (() => {
          const s = window.__spider.scene;
          const l = s.layout;
          let lowest = 0;
          let highest = Infinity;
          let left = Infinity;
          let right = -Infinity;
          for (const sprite of s.cardSprites.values()) {
            lowest = Math.max(lowest, sprite.y + sprite.displayHeight / 2);
            highest = Math.min(highest, sprite.y - sprite.displayHeight / 2);
            left = Math.min(left, sprite.x - sprite.displayWidth / 2);
            right = Math.max(right, sprite.x + sprite.displayWidth / 2);
          }
          return {
            lowest: Math.round(lowest),
            highest: Math.round(highest),
            columnTopY: Math.round(l.columnTopY),
            bottom: Math.round(l.tableauBottom),
            left: Math.round(left),
            right: Math.round(right),
            canvasW: Math.round(l.width),
            fits:
              // 纹理格留了投影余量，精灵包围盒比看得见的牌面四周各大 1~3px，所以上下都给几像素容差
              lowest <= l.tableauBottom + 5 &&
              highest >= l.columnTopY - 5 &&
              left >= -1 &&
              right <= l.width + 1,
          };
        })(),
      };
    })()`);

  /**
   * 5 列之后开局不一定马上就「有好走法」，没有就先发一轮再找。
   * 走 scene.requestDeal() 而不是直接改模拟层，这样动画/同步都会正常跑。
   */
  const ensureHint = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const hint = await evaluate(
        `(() => { const h = window.__spider.game().hint(); return h && { ...h }; })()`,
      );
      if (hint) return hint;
      const dealt = await evaluate(`(() => {
        const g = window.__spider.game();
        if (g.remainingDeals === 0) return false;
        window.__spider.scene.requestDeal();
        return true;
      })()`);
      if (!dealt) return null;
      await delay(800);
    }
    return null;
  };

  // ------------------------------------------------------------------ 1. 开场
  await setViewport(DESKTOP);
  await cdp.send('Page.navigate', { url: `${PAGE_URL}` });
  await delay(180);
  const splash = await evaluate(`(() => {
    const node = document.querySelector('#boot-splash');
    return { present: !!node, hidden: node ? node.classList.contains('splash--hidden') : false };
  })()`);
  record('首屏先显示加载页（手机不会白屏）', splash.present && !splash.hidden, JSON.stringify(splash));
  await shoot('00-loading');
  await delay(1200);
  await shoot('01-start-panel');
  const boot = await evaluate(`(() => ({
    title: document.title,
    hud: !!document.querySelector('.hud'),
    canvas: !!document.querySelector('#stage canvas'),
    panel: document.querySelector('.panel__title')?.textContent ?? '',
    difficulties: document.querySelectorAll('.difficulty').length,
    hasDebugApi: !!window.__spider,
    audio: window.__spider ? 'ok' : 'missing',
    splashGone: !document.querySelector('#boot-splash') ||
      document.querySelector('#boot-splash').classList.contains('splash--hidden'),
  }))()`);
  record('页面启动并显示开局面板', boot.hud && boot.canvas && boot.panel === '蜘蛛纸牌', JSON.stringify(boot));
  record('难度选项齐全（1/2/4 花色）', boot.difficulties === 3);
  record('素材加载完成后自动收起加载页', boot.splashGone === true);

  // ------------------------------------------------------------------ 2. 开局（真实点击 → 同时验证音频解锁）
  await clickButton('开始新局');
  await delay(700);
  const audio = await evaluate(`window.__spider.audio()`);
  record(
    '音频引擎在手势后解锁（AudioContext running + 背景音乐已启动）',
    audio.ready && audio.state === 'running' && audio.musicPlaying,
    JSON.stringify(audio),
  );
  await clickButton('🔊');
  const soundOff = await evaluate(`window.__spider.audio()`);
  await clickButton('🔇');
  const soundOn = await evaluate(`window.__spider.audio()`);
  record(
    '静音按钮可以关掉并恢复全部声音',
    soundOff.sfx === false && soundOff.music === false && soundOn.sfx === true && soundOn.music === true,
    JSON.stringify({ soundOff, soundOn }),
  );

  // ------------------------------------------------------------------ 牌面素材校验（图集）
  const arts = await evaluate(`(async () => {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图集加载失败'));
      img.src = 'assets/cards/atlas.png';
    });
    const CELL_W = 200, CELL_H = 277, CARD_W = 194, CARD_H = 269;
    const ROW = { S: 0, H: 1, D: 2, C: 3 };
    const canvas = document.createElement('canvas');
    canvas.width = CELL_W;
    canvas.height = CELL_H;
    const ctx = canvas.getContext('2d');
    const analyse = (suit, rank) => {
      ctx.clearRect(0, 0, CELL_W, CELL_H);
      ctx.drawImage(image, (rank - 1) * CELL_W, ROW[suit] * CELL_H, CELL_W, CELL_H, 0, 0, CELL_W, CELL_H);
      const data = ctx.getImageData(0, 0, CELL_W, CELL_H).data;
      let diff = 0, samples = 0, ink = 0, red = 0, dark = 0;
      let minX = CARD_W, maxX = -1, minY = CARD_H, maxY = -1;
      for (let y = 2; y < CARD_H - 2; y += 1) {
        for (let x = 2; x < CARD_W - 2; x += 1) {
          const i = (y * CELL_W + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a > 100 && r + g + b < 600) {
            ink += 1;
            if (r > g + 50 && r > b + 50) red += 1;
            else if (r < 110 && g < 110 && b < 110) dark += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
          if (x % 2 === 0 && y % 2 === 0) {
            const j = ((CARD_H - 1 - y) * CELL_W + (CARD_W - 1 - x)) * 4;
            diff += Math.abs(r - data[j]) + Math.abs(g - data[j + 1]) + Math.abs(b - data[j + 2]);
            samples += 1;
          }
        }
      }
      const area = (CARD_W - 4) * (CARD_H - 4);
      return {
        ink: ink / area,
        redRatio: ink ? red / ink : 0,
        darkRatio: ink ? dark / ink : 0,
        symmetry: diff / samples / 3,
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2,
      };
    };
    const out = { all: [], courts: [], aces: [] };
    for (const suit of ['S', 'H', 'D', 'C']) {
      for (let rank = 1; rank <= 13; rank += 1) {
        const m = analyse(suit, rank);
        out.all.push({ key: suit + rank, ...m });
        if (rank >= 11) out.courts.push({ key: suit + rank, ...m });
        if (rank === 1) out.aces.push({ key: suit + rank, ...m });
      }
    }
    const highlight = window.__spider.phaser.textures.get('fx_highlight').getSourceImage();
    const hd = highlight.getContext('2d').getImageData(0, 0, highlight.width, highlight.height).data;
    let peakAlpha = 0, lit = 0;
    for (let i = 0; i < hd.length; i += 4) {
      if (hd[i + 3] > peakAlpha) peakAlpha = hd[i + 3];
      if (hd[i + 3] > 8) lit += 1;
    }
    return {
      all: out.all,
      courts: out.courts,
      aces: out.aces,
      highlight: { peakAlpha, coverage: lit / (highlight.width * highlight.height) },
      atlas: [image.naturalWidth, image.naturalHeight],
    };
  })()`);

  const blanks = arts.all.filter((c) => c.ink < 0.02);
  record(
    '图集 52 张牌面全部有内容（没有空牌/错位）',
    arts.all.length === 52 && blanks.length === 0,
    blanks.length ? `空白：${blanks.map((c) => c.key).join(',')}` : `图集 ${arts.atlas.join('x')}`,
  );
  // 红桃/方块的整张牌里一定有明显的红色；黑桃/梅花几乎不含红色。
  // （人头牌是彩色插画，暗色线稿比红色多，所以只能比「红 vs 无红」。）
  const blackSuits = arts.all.filter((c) => c.key.startsWith('S') || c.key.startsWith('C'));
  const redSuits = arts.all.filter((c) => c.key.startsWith('H') || c.key.startsWith('D'));
  // 人头牌是彩色插画（黑桃/梅花的人头牌里也有红色），所以门槛按「点数牌 / 人头牌」分开
  const redExpectation = (key) => {
    const rank = Number(key.slice(1));
    return rank >= 11 ? { min: 0.27, max: 1 } : { min: 0, max: 0.15 };
  };
  const blackNoRed = blackSuits
    .filter((c) => c.redRatio > redExpectation(c.key).max)
    .map((c) => c.key);
  const redHasRed = redSuits
    .filter((c) => {
      const rank = Number(c.key.slice(1));
      return rank >= 11 ? c.redRatio < 0.27 : c.redRatio < 0.5;
    })
    .map((c) => c.key);
  record(
    '图集行序正确：黑桃/梅花是黑牌，红桃/方块是红牌',
    blackNoRed.length === 0 && redHasRed.length === 0,
    `黑牌含红：${blackNoRed.join(',') || '无'}；红牌缺红：${redHasRed.join(',') || '无'}`,
  );
  const worstCourt = [...arts.courts].sort((a, b) => b.symmetry - a.symmetry)[0];
  record(
    '人头牌是传统「双头」画法（旋转 180° 后图形基本重合）',
    worstCourt.symmetry < 6,
    `最差 ${worstCourt.key} = ${worstCourt.symmetry.toFixed(1)}`,
  );
  const worstAce = [...arts.aces]
    .map((a) => ({ ...a, dx: Math.abs(a.centerX - 97), dy: Math.abs(a.centerY - 134.5) }))
    .sort((a, b) => b.dx + b.dy - (a.dx + a.dy))[0];
  record(
    'A 的大花色居中',
    worstAce.dx <= 6 && worstAce.dy <= 6,
    `最差 ${worstAce.key} 偏移 (${worstAce.dx.toFixed(1)}, ${worstAce.dy.toFixed(1)})`,
  );
  record(
    '选中高亮是柔和光晕而不是硬金色边框',
    arts.highlight.peakAlpha < 130 && arts.highlight.coverage > 0.15 && arts.highlight.coverage < 0.5,
    JSON.stringify(arts.highlight),
  );

  await delay(900);
  await shoot('02-tableau');
  let info = await summarize();
  record(
    '开局：27 张上桌（5 列）、5 轮发牌、52 张守恒',
    info.onTable === 27 && info.stock === 5 && info.total === 52,
    JSON.stringify({ onTable: info.onTable, stock: info.stock, total: info.total }),
  );
  record('牌面纵向排布不溢出可视区域', info.overflow.fits, JSON.stringify(info.overflow));

  // 像素级检查：牌面 / 牌背 / 绒布都真的画出来了
  const pixels = await samplePixels();
  record(
    '卡面渲染正常（明牌区是不透明卡面、牌堆区是蓝白牌背、空白区透出绒布）',
    // 明牌区：必须是不透明的卡面（真牌面有大量线稿，所以看「有墨」而不是「够白」）
    pixels.regions.face.transparent < 0.05 &&
      pixels.regions.face.ivory + pixels.regions.face.dark + pixels.regions.face.red > 0.6 &&
      pixels.regions.face.dark + pixels.regions.face.red > 0.02 &&
      // 牌背：新牌背是蓝白花纹，所以看「有不透明内容 + 明显的蓝」
      pixels.regions.back.transparent < 0.05 &&
      pixels.regions.back.blue > 0.1 &&
      pixels.regions.felt.transparent > 0.85,
    `${JSON.stringify(pixels.regions)} profile=${JSON.stringify(pixels.profile)}`,
  );
  record(
    '画面覆盖合理：卡牌与绒布比例正常，没有整体发黑或空白',
    pixels.metrics.ivory > 0.04 &&
      pixels.metrics.ivory < 0.35 &&
      pixels.metrics.dark > 0.01 &&
      pixels.metrics.dark < 0.5 &&
      pixels.metrics.transparent > 0.4,
    JSON.stringify(pixels.metrics),
  );

  // ------------------------------------------------------------------ 3. 点击选牌 + 点列落牌
  const hintBefore = await ensureHint();
  // 取一次最新的步数：ensureHint 里可能已经发过牌（发牌也算一步）
  const movesBefore = (await summarize()).moves;
  if (hintBefore) {
    const from = await pointFor(hintBefore.from, hintBefore.index);
    const to = await pointFor(hintBefore.to, 0, 'bottom');
    await click(from.x, from.y);
    await shoot('03a-selected');
    await click(to.x, to.y);
    await delay(320);
    info = await summarize();
    record('点击选牌 → 点击目标列可以落牌', info.moves === movesBefore + 1, `${movesBefore} → ${info.moves}`);
    await shoot('03b-after-click-move');
  } else {
    record('点击选牌 → 点击目标列可以落牌', false, '没有找到可走的提示');
  }

  // ------------------------------------------------------------------ 4. 拖拽
  await evaluate(`(() => {
    const s = window.__spider.scene;
    window.__probe = { start: 0, blocked: 0, move: 0, drop: 0, invalid: 0, lastStart: null };
    const wrap = (name, key) => {
      const original = s[name].bind(s);
      s[name] = (...args) => {
        window.__probe[key] += 1;
        if (key === 'start') window.__probe.lastStart = { ...s.locations.get(args[1].getData('cardId')) };
        return original(...args);
      };
    };
    wrap('onDragStart', 'start');
    wrap('onDragEnd', 'drop');
    wrap('performMove', 'move');
    return true;
  })()`);
  const dragHint = await ensureHint();
  if (dragHint) {
    const before = (await summarize()).moves;
    const from = await pointFor(dragHint.from, dragHint.index);
    const to = await pointFor(dragHint.to, 0, 'bottom');
    await drag(from, to);
    const after = await summarize();
    const probe = await evaluate(`window.__probe`);
    record(
      '拖拽落牌可以完成一次移动',
      after.moves === before + 1,
      `${before} → ${after.moves} hint=${JSON.stringify(dragHint)} probe=${JSON.stringify(probe)} from=${JSON.stringify(from)} to=${JSON.stringify(to)}`,
    );
    await shoot('04-after-drag');
  }

  // ------------------------------------------------------------------ 4b. 拖到非法位置：牌要回位，且不能留下任何高亮残影
  const invalidPlan = await evaluate(`(() => {
    const g = window.__spider.game();
    const hint = g.hint();
    if (!hint) return null;
    for (let to = 0; to < 10; to += 1) {
      if (to === hint.from) continue;
      if (!g.canMove(hint.from, hint.index, to)) return { from: hint.from, index: hint.index, to };
    }
    return null;
  })()`);
  if (invalidPlan) {
    const before = await summarize();
    const from = await pointFor(invalidPlan.from, invalidPlan.index);
    const to = await pointFor(invalidPlan.to, 0, 'bottom');
    await drag(from, to);
    await delay(450);
    const after = await summarize();
    const residue = await evaluate(`(() => {
      const s = window.__spider.scene;
      return {
        highlight: s.highlight.visible,
        glow: s.targetGlow.visible,
        dragging: s.dragging,
        glowAlpha: s.targetGlow.alpha,
        cardsInDrag: [...s.cardSprites.values()].filter((c) => c.depth >= 9000).length,
      };
    })()`);
    record(
      '拖到错误位置：牌回到原位且不执行移动',
      after.moves === before.moves && after.overflow.fits,
      `${before.moves} → ${after.moves}`,
    );
    record(
      '拖到错误位置后不留任何金色高亮 / 光效残影',
      residue.highlight === false && residue.glow === false && residue.dragging === false && residue.cardsInDrag === 0,
      JSON.stringify(residue),
    );
    await shoot('04b-invalid-drop');
  }

  // ------------------------------------------------------------------ 5. 双击自动归位
  const autoTarget = await evaluate(`(() => {
    const g = window.__spider.game();
    const st = g.state;
    for (let col = 0; col < st.columns.length; col += 1) {
      const column = st.columns[col];
      for (let i = column.length - 1; i >= 0; i -= 1) {
        if (g.autoMoveTarget(col, i) !== null) return { col, i };
      }
    }
    return null;
  })()`);
  if (autoTarget) {
    const before = (await summarize()).moves;
    const point = await pointFor(autoTarget.col, autoTarget.i);
    await doubleClick(point.x, point.y);
    const after = await summarize();
    record('双击明牌自动归位', after.moves === before + 1, `${before} → ${after.moves}`);
    await shoot('05-after-doubleclick');
  }

  // ------------------------------------------------------------------ 6. 发牌 + 撤销
  const beforeDeal = await summarize();
  const stock = await stockPoint();
  await click(stock.x, stock.y);
  await delay(600);
  const afterDeal = await summarize();
  record(
    '点牌堆发一轮：每列 +1 张、牌堆 -1 轮',
    afterDeal.stock === beforeDeal.stock - 1 && afterDeal.onTable === beforeDeal.onTable + 5,
    JSON.stringify({ stock: afterDeal.stock, onTable: afterDeal.onTable }),
  );
  await shoot('06-after-deal');

  await clickButton('撤销');
  await delay(500);
  const afterUndo = await summarize();
  record('撤销回退一次发牌', afterUndo.stock === beforeDeal.stock && afterUndo.onTable === beforeDeal.onTable);

  // ------------------------------------------------------------------ 7. 提示
  await ensureHint();
  await clickButton('提示');
  await delay(400);
  const hintToast = (await summarize()).toast;
  record('提示按钮给出可执行建议', hintToast.includes('提示'), hintToast);
  await shoot('07-hint');

  // ------------------------------------------------------------------ 8. 空列不能发牌
  await evaluate(`(() => {
    const st = window.__spider.state();
    st.columns[0] = [];
    window.__spider.syncLayout();
  })()`);
  await delay(200);
  const stock2 = await stockPoint();
  await click(stock2.x, stock2.y);
  await delay(400);
  const warn = (await summarize()).toast;
  record('有空列时发牌被拒绝并给出说明', warn.includes('空列'), warn);
  await shoot('08-empty-column-warning');

  // ------------------------------------------------------------------ 9. 通关流程
  await evaluate(`(() => {
    let id = 9000;
    const card = (suit, rank, faceUp = true) => ({ id: id += 1, suit, rank, faceUp });
    const columns = Array.from({ length: 5 }, () => []);
    for (let rank = 13; rank >= 2; rank -= 1) columns[0].push(card('S', rank));
    columns[1].push(card('S', 1));
    for (let col = 2; col < 5; col += 1) columns[col].push(card('C', 8, false));
    const state = {
      version: 1, suitCount: 4, seed: 1, columns, stock: [],
      sets: ['H', 'D', 'C'],
      score: 420, moves: 18, elapsedMs: 184000, status: 'playing',
    };
    window.__spider.load(JSON.stringify(state));
  })()`);
  await delay(400);
  const acePoint = await pointFor(1, 0);
  const kingRunPoint = await pointFor(0, 11);
  await click(acePoint.x, acePoint.y);
  await click(kingRunPoint.x, kingRunPoint.y);
  await delay(260);
  await shoot('09-completing-set');
  await delay(1600);
  const won = await summarize();
  record('凑齐第 4 组后触发通关（+100 分）', won.sets === 4 && won.status === 'won', JSON.stringify({ sets: won.sets, status: won.status, score: won.score }));
  record('通关面板自动弹出', won.overlay >= 1, `overlay=${won.overlay}`);
  await shoot('10-win-panel');

  // ------------------------------------------------------------------ 10. 手机视口
  await setViewport(MOBILE);
  await delay(700);
  await evaluate(`window.__spider.newGame(1, 4242)`);
  await delay(900);
  const mobile = await summarize();
  record('手机竖屏：牌面完整可见不溢出', mobile.overflow.fits, JSON.stringify(mobile.overflow));
  record('手机竖屏：画布尺寸跟随视口', mobile.canvas[0] <= 390 && mobile.canvas[0] > 300, JSON.stringify(mobile.canvas));

  // 手机端可读性 / 可点性：牌要够大、所有按钮都要够大、发牌要在右下角
  const mobileUi = await evaluate(`(() => {
    const box = (node) => {
      const r = node.getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        left: Math.round(r.left), right: Math.round(r.right),
        top: Math.round(r.top), bottom: Math.round(r.bottom),
      };
    };
    const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
    const tooSmall = buttons
      .map((b) => ({ label: b.textContent.trim().slice(0, 8) || b.getAttribute('aria-label'), ...box(b) }))
      .filter((b) => b.w < 44 || b.h < 44);
    const deal = document.querySelector('.dock__deal');
    const scene = window.__spider.scene;
    const canvas = document.querySelector('#stage canvas');
    const rect = canvas.getBoundingClientRect();
    return {
      viewport: [window.innerWidth, window.innerHeight],
      buttons: buttons.length,
      tooSmall,
      deal: deal ? box(deal) : null,
      dealDisabled: deal ? deal.disabled : null,
      cardW: Math.round(scene.layout.cardW),
      cardH: Math.round(scene.layout.cardH),
      columns: scene.layout.columnX.length,
      devicePixelRatio: window.devicePixelRatio,
      canvasBacking: [canvas.width, canvas.height],
      canvasCss: [Math.round(rect.width), Math.round(rect.height)],
      backingRatio: +(canvas.width / rect.width).toFixed(2),
    };
  })()`);
  record(
    '手机竖屏：牌面明显变大（宽 ≥ 60px）且只有 5 列',
    mobileUi.columns === 5 && mobileUi.cardW / (mobileUi.devicePixelRatio || 1) >= 60,
    `牌面 ${mobileUi.cardW}x${mobileUi.cardH} 画布像素（≈${Math.round(mobileUi.cardW / mobileUi.devicePixelRatio)} CSS px），${mobileUi.columns} 列`,
  );
  record(
    '手机（DPR 3）：画布按设备像素渲染，牌面接近 1:1 不虚',
    mobileUi.backingRatio >= 2.9 &&
      mobileUi.canvasBacking[0] / mobileUi.devicePixelRatio >= mobileUi.canvasCss[0] - 2 &&
      // 牌面素材每张 194px 宽，渲染出来的物理宽度要贴近它，才是「不拉伸 / 不发虚」
      Math.abs(mobileUi.cardW - 194) / 194 <= 0.25,
    `backingRatio=${mobileUi.backingRatio}，画布 ${mobileUi.canvasBacking.join('x')}，CSS ${mobileUi.canvasCss.join('x')}，牌面 ${mobileUi.cardW}px（素材 194px）`,
  );
  record(
    '手机端所有按钮都 ≥ 44px（拇指不易误触）',
    mobileUi.tooSmall.length === 0,
    mobileUi.tooSmall.length ? JSON.stringify(mobileUi.tooSmall) : `共 ${mobileUi.buttons} 个按钮`,
  );
  record(
    '发牌按钮位于屏幕右下角',
    !!mobileUi.deal &&
      mobileUi.deal.right >= mobileUi.viewport[0] - 16 &&
      mobileUi.deal.bottom >= mobileUi.viewport[1] - 120 &&
      mobileUi.deal.w >= 110,
    JSON.stringify(mobileUi.deal),
  );
  await shoot('11-mobile-tableau');
  await clickButton('☰');
  await delay(500);
  await shoot('12-mobile-menu');
  const menuOpen = (await summarize()).overlay;
  record('手机端菜单面板可用', menuOpen >= 1);
  await clickButton('✕');
  await delay(400);

  // 手机横屏
  await setViewport({ width: 844, height: 390, mobile: true });
  await delay(700);
  const landscape = await summarize();
  record('手机横屏：牌面依旧完整可见', landscape.overflow.fits, JSON.stringify(landscape.overflow));
  await shoot('13-mobile-landscape');

  // 小屏手机（iPhone SE 一类）：10 列必须横向也放得下
  await setViewport({ width: 320, height: 568, mobile: true });
  await delay(700);
  const small = await summarize();
  record(
    '小屏手机（320px）：牌桌横向不溢出',
    small.overflow.fits && small.overflow.left >= 0 && small.overflow.right <= 320,
    JSON.stringify(small.overflow),
  );
  await shoot('14-mobile-small');

  // ------------------------------------------------------------------ 11. 牌面预览页
  await setViewport({ width: 1280, height: 900 });
  await cdp.send('Page.navigate', { url: new URL('cards.html', PAGE_URL).href });
  await delay(1600);
  const gallery = await evaluate(`(() => {
    const canvases = [...document.querySelectorAll('figure canvas')];
    const blank = canvases.filter((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] < 640) ink += 1;
      }
      return ink < c.width * c.height * 0.005;
    }).length;
    return { canvases: canvases.length, blank, captions: document.querySelectorAll('figcaption').length };
  })()`);
  record(
    '牌面预览页画出全部 52 张牌 + 牌背',
    gallery.canvases === 53 && gallery.blank === 0 && gallery.captions === 53,
    JSON.stringify(gallery),
  );
  await shoot('15-card-gallery');

  // ------------------------------------------------------------------ 12. 手机触屏操作（用真实触摸事件，不是鼠标）
  await setViewport(MOBILE);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Page.navigate', { url: `${PAGE_URL}` });
  await delay(1600);
  await clickButton('开始新局');
  await delay(900);

  // 触屏测试用一个「必定有走法」的固定局面，避免开局运气影响用例
  await evaluate(`(() => {
    let id = 7000;
    const card = (suit, rank, faceUp = true) => ({ id: id += 1, suit, rank, faceUp });
    const columns = [
      [card('S', 9)],   // ① 可以压到 10♥ 上（点选测试）
      [card('H', 10)],
      [card('D', 4)],   // ② 可以压到 5♣ 上（拖动测试）
      [card('C', 5)],
      [card('C', 8)],   // ③ 可以自动归位到 9♠ 上（双击测试）
    ];
    window.__spider.load(JSON.stringify({
      version: 1, suitCount: 1, seed: 5, columns, stock: [], sets: [],
      score: 500, moves: 0, elapsedMs: 0, status: 'playing',
    }));
  })()`);
  await delay(500);

  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const touchTap = async (x, y) => {
    await touch('touchStart', [{ x, y }]);
    await delay(45);
    await touch('touchEnd', []);
    await delay(160);
  };
  const touchDrag = async (from, to) => {
    await touch('touchStart', [{ x: from.x, y: from.y }]);
    for (let i = 1; i <= 10; i += 1) {
      await touch('touchMove', [
        { x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 },
      ]);
      await delay(16);
    }
    await delay(60);
    await touch('touchEnd', []);
    await delay(320);
  };

  const touchHint = await evaluate(`(() => { const h = window.__spider.game().hint(); return h && { ...h }; })()`);
  let movedByTouch = 0;
  if (touchHint) {
    const before = (await summarize()).moves;
    const from = await pointFor(touchHint.from, touchHint.index);
    const to = await pointFor(touchHint.to, 0, 'bottom');
    await touchTap(from.x, from.y);
    await touchTap(to.x, to.y);
    movedByTouch = (await summarize()).moves - before;
  }
  record('触屏：点一下选牌、再点目标列可以落牌', movedByTouch === 1, `步数 +${movedByTouch}`);

  const dragHint2 = await evaluate(`(() => { const h = window.__spider.game().hint(); return h && { ...h }; })()`);
  let dragByTouch = 0;
  if (dragHint2) {
    const before = (await summarize()).moves;
    const from = await pointFor(dragHint2.from, dragHint2.index);
    const to = await pointFor(dragHint2.to, 0, 'bottom');
    await touchDrag(from, to);
    dragByTouch = (await summarize()).moves - before;
  }
  record('触屏：手指拖动整段牌可以落牌', dragByTouch === 1, `步数 +${dragByTouch}`);

  const scrollAfterTouch = await evaluate(`({ y: window.scrollY, x: window.scrollX })`);
  record('触屏拖动不会带动页面滚动', scrollAfterTouch.y === 0 && scrollAfterTouch.x === 0, JSON.stringify(scrollAfterTouch));

  const autoTapTarget = await evaluate(`(() => {
    const g = window.__spider.game();
    const st = g.state;
    for (let col = 0; col < 5; col += 1) {
      const column = st.columns[col];
      for (let i = column.length - 1; i >= 0; i -= 1) {
        if (g.autoMoveTarget(col, i) !== null) return { col, i };
      }
    }
    return null;
  })()`);
  let autoByTouch = 0;
  if (autoTapTarget) {
    const point = await pointFor(autoTapTarget.col, autoTapTarget.i);
    // CDP 往返偶尔会被系统负载拖慢，手抖一下重试一次（真人双击也可能第一次只选中）
    for (let attempt = 0; attempt < 2 && autoByTouch === 0; attempt += 1) {
      const before = (await summarize()).moves;
      await touchTap(point.x, point.y);
      await delay(40);
      await touchTap(point.x, point.y);
      autoByTouch = (await summarize()).moves - before;
      if (autoByTouch === 0) {
        await evaluate(`window.__spider.scene.clearSelection()`);
        await delay(120);
      }
    }
  }
  record('触屏：双击自动归位', autoByTouch === 1, `步数 +${autoByTouch}`);
  await shoot('16-mobile-touch');

  // ------------------------------------------------------------------ 13. 牌面映射端到端校验
  // 分别把一张 A♠ / A♥ 摆到桌面，再读真实渲染结果：颜色必须分别是黑/红，
  // 这样能确证「图集里的哪一格」与「桌面上哪张牌」是对上的（防错位）。
  await setViewport(DESKTOP);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await delay(400);
  const artMapping = await evaluate(`(async () => {
    const measure = async (suit) => {
      const columns = Array.from({ length: 5 }, (_, i) => [
        i === 0
          ? { id: 1, suit, rank: 1, faceUp: true }
          : { id: 10 + i, suit: 'S', rank: 3, faceUp: false },
      ]);
      window.__spider.load(JSON.stringify({
        version: 1, suitCount: 4, seed: 7, columns, stock: [], sets: [],
        score: 500, moves: 0, elapsedMs: 0, status: 'playing',
      }));
      await new Promise((r) => setTimeout(r, 300));
      const scene = window.__spider.scene;
      const layout = scene.layout;
      const sprite = scene.cardSprites.get(1);
      const textureKey = sprite.texture.key;
      const renderer = window.__spider.phaser.renderer;
      const region = {
        x: sprite.x - sprite.displayWidth * 0.35,
        y: sprite.y - sprite.displayHeight * 0.35,
        w: sprite.displayWidth * 0.7,
        h: sprite.displayHeight * 0.7,
      };
      void layout;
      const stats = await new Promise((resolve) => {
        renderer.snapshot((image) => {
          const c = document.createElement('canvas');
          c.width = image.width;
          c.height = image.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(image, 0, 0);
          const data = ctx.getImageData(
            Math.round(region.x), Math.round(region.y),
            Math.round(region.w), Math.round(region.h),
          ).data;
          let red = 0, dark = 0, light = 0, total = 0;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            total += 1;
            if (r > g + 50 && r > b + 50) red += 1;
            else if (r + g + b < 330) dark += 1;
            else light += 1;
          }
          resolve({ red: red / total, dark: dark / total, light: light / total });
        });
      });
      return { suit, textureKey, ...stats };
    };
    const spade = await measure('S');
    const heart = await measure('H');
    return { spade, heart };
  })()`);
  record(
    '牌面映射正确：A♠ 渲染成黑牌、A♥ 渲染成红牌',
    artMapping.spade.textureKey === 'card_S_1' &&
      artMapping.heart.textureKey === 'card_H_1' &&
      artMapping.spade.red < 0.02 &&
      artMapping.spade.dark > 0.03 &&
      artMapping.heart.dark < 0.02 &&
      artMapping.heart.red > 0.03,
    JSON.stringify(artMapping),
  );
  await shoot('17-art-mapping');

  record('运行期间没有 JS 报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (error) {
  record('测试脚本执行', false, String(error?.message ?? error));
  console.error(error);
} finally {
  try {
    await cdp?.send('Browser.close');
  } catch {
    /* 忽略 */
  }
  chrome.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (consoleErrors.length) {
  console.log('控制台错误：');
  consoleErrors.slice(0, 10).forEach((line) => console.log(`  - ${line}`));
}
process.exit(failed.length === 0 ? 0 : 1);
