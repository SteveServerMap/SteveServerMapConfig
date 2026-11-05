// 临时诊断脚本：检查真实站点仓库下的工具是否走了瓦片底图（用完即删）
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRepo = 'D:\\Project\\Github\\SteveServerMap.github.io';
const headless = await import(pathToFileURL(path.join(siteRepo, 'tests', 'headless.mjs')).href);
const { launchBrowser, CDP, Page, waitUntil, createDiagnostics } = headless;

const TARGET = process.argv[2] || 'http://127.0.0.1:5399/';

let browser = null;
let conn = null;
try {
  browser = await launchBrowser({ headless: true });
  conn = await CDP.connect(browser.wsUrl);
  const page = await Page.open(conn);
  const diag = createDiagnostics(page, { ignore: () => false });
  await page.setViewport({ width: 1280, height: 800 });
  await page.navigate(TARGET, { timeout: 30000, waitUntil: 'load' });
  await waitUntil(async () => (await page.evalFn(() => Boolean(window.__tool))), { timeout: 20000, label: '工具启动' });
  await new Promise((r) => setTimeout(r, 4500));

  const facts = await page.evalFn(() => {
    const tool = window.__tool;
    const st = tool.state();
    const dim = st.draft.dimensions[st.dimensionIndex ?? 0] || st.draft.dimensions[0];
    const canvas = tool.canvas;
    const info = document.getElementById('canvas-info');
    const img = document.getElementById('canvas-image');
    const tileCanvas = document.getElementById('canvas-tiles');
    return {
      dimId: dim && dim.id,
      dimTiles: dim ? dim.tiles : 'MISSING-FIELD',
      dimImage: dim ? dim.image : null,
      tileMeta: dim ? dim.tileMeta : null,
      imageMeta: dim ? dim.imageMeta : null,
      tileModule: Boolean(st.tileModule),
      canvasInfo: info ? (info.textContent || '').trim() : null,
      imageNatural: img ? { w: img.naturalWidth, h: img.naturalHeight, display: getComputedStyle(img).display } : null,
      tileDisplay: tileCanvas ? getComputedStyle(tileCanvas).display : null,
      tileStats: typeof canvas?.getTileStats === 'function' ? canvas.getTileStats() : null,
      hasSetTileset: typeof canvas?.setTileset === 'function',
    };
  });
  console.log(JSON.stringify(facts, null, 2));
  console.log('--- diagnostics ---');
  console.log(JSON.stringify({ errors: diag.errors, warnings: diag.warnings, requests: diag.requests }, null, 2).slice(0, 4000));
} finally {
  try {
    await conn?.close?.();
  } catch {}
  try {
    await browser?.close?.();
  } catch {}
}
