import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as model from '../assets/js/model.js';
import * as coords from '../../SteveServerMap.github.io/assets/js/coords.js';

const source = (await fs.readFile(new URL('../assets/js/app.js', import.meta.url), 'utf8'))
  .replace(/^(?:import|export) .*;\r?\n/gm, '')
  .replace(/bootstrap\(\)\.catch\([\s\S]*?\n\}\);/, '');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(id = 'a') {
  return {
    id, name: id, image: `${id}.png`, tiles: null,
    calibration: { calibrated: true, xMin: 0, xMax: 100, zMin: 0, zMax: 100, flipZ: false },
    groups: [{ id: 'default', name: '默认', color: '#ffffff', visible: true }],
    waypoints: [{ id: 'point', name: 'point', x: 10, z: 10, group: 'default', icon: 'pin' }],
    imageMeta: { width: 100, height: 100, missing: false },
  };
}

function harness() {
  const images = [];
  const paints = [];
  const timers = new Map();
  let nextTimer = 0;
  const elements = new Map([['draft-meta', {}]]);
  const listeners = new Map();
  const context = vm.createContext({
    model, coords, console, URL, Blob,
    document: {
      body: { dataset: {} }, title: '',
      getElementById: (id) => elements.get(id) || null,
      querySelectorAll: () => [],
      addEventListener: (name, fn) => listeners.set(name, fn),
    },
    window: { addEventListener: (name, fn) => listeners.set(name, fn) },
    localStorage: { getItem: () => null },
    setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
    Image: class {
      constructor() { images.push(this); }
    },
    mockCanvas: new Proxy({}, { get: (_, name) => {
      if (name === 'getViewState') return () => ({ scale: 1, tx: 0, ty: 0, viewWidth: 100, viewHeight: 100 });
      return (...args) => paints.push({ name, args });
    } }),
  });
  const run = (code) => vm.runInContext(code, context);
  run(source);
  run(`state.coords = coords; canvas = mockCanvas; state.enhancePref = false;
    state.siteExists = true; state.images = [{ name: 'a.png' }, { name: 'b.png' }];`);
  const draft = model.createEmptyDraft();
  draft.dimensions = [fixture('a'), fixture('b')];
  draft.defaultDimension = 'a';
  context.draftFixture = draft;
  run('state.draft = draftFixture; state.selection.dimensionId = "a";');
  return { context, run, images, paints, timers, elements, listeners, state: run('state') };
}

async function tick() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('保存响应不清除请求期间的新编辑，并把最新草稿排入持久化', async () => {
  const h = harness();
  const saving = deferred();
  const writes = [];
  h.context.apiStub = async (url, options) => {
    if (url === '/api/save') return saving.promise;
    writes.push(options.body.draft);
    return { ok: true };
  };
  h.run('api = apiStub; state.dirty = true;');
  const result = h.run('saveToSite()');
  h.run(`handlePatch({ kind: 'site', field: 'title', value: 'new title' })`);
  saving.resolve({ ok: true, bytes: 100, savedAt: 'now' });
  assert.equal((await result).ok, true);
  assert.equal(h.state.dirty, true);
  assert.equal(writes.at(-1).site.title, 'new title');
  assert.equal(h.state.draftPending, false);
  assert.match(h.context.document.title, /^●/);
});

test('草稿写入按快照串行执行，失败不堵塞后续写入', async () => {
  const h = harness();
  const first = deferred();
  const calls = [];
  h.context.apiStub = async (_, options) => {
    calls.push(options.body.draft.site.title);
    if (calls.length === 1) return first.promise;
    return { ok: true };
  };
  h.run('api = apiStub; state.draft.site.title = "old";');
  const a = h.run('persistDraft()');
  h.run('state.draft.site.title = "new";');
  const b = h.run('persistDraft()');
  await tick();
  assert.deepEqual(calls, ['old']);
  first.reject(new Error('test write failure'));
  assert.equal(await a, false);
  assert.equal(await b, true);
  assert.deepEqual(calls, ['old', 'new']);
  assert.equal(h.state.draftPending, false);
});

test('快速 A→B→A 不会在旧 A 写入完成时过早解除离页保护', async () => {
  const h = harness();
  const writes = [deferred(), deferred(), deferred()];
  let calls = 0;
  h.context.apiStub = () => writes[calls++].promise;
  h.run('api = apiStub; state.draft.site.title = "A";');
  const a = h.run('persistDraft()');
  h.run('state.draft.site.title = "B";');
  const b = h.run('persistDraft()');
  h.run('state.draft.site.title = "A"; scheduleAutosave();');
  writes[0].resolve({ ok: true });
  await a;
  assert.equal(h.state.draftPending, true);
  const latest = h.run('persistDraft()');
  writes[1].resolve({ ok: true });
  await b;
  assert.equal(h.state.draftPending, true);
  writes[2].resolve({ ok: true });
  await latest;
  assert.equal(h.state.draftPending, false);
});

test('读取站点取消旧计时器，并在旧在途草稿之后写入替换草稿', async () => {
  const h = harness();
  const first = deferred();
  const calls = [];
  const config = model.toConfigJson(h.state.draft);
  config.site.title = 'from site';
  h.context.apiStub = async (url, options) => {
    if (url === '/api/site-config') return { ok: true, config };
    calls.push(options.body.draft.site.title);
    return calls.length === 1 ? first.promise : { ok: true };
  };
  h.run('api = apiStub; activateDimension = async () => {}; showConfirm = async () => true; state.dirty = true; state.draft.site.title = "old draft";');
  const old = h.run('persistDraft()');
  h.run('scheduleAutosave()');
  const timer = h.state.autosaveTimer;
  const reloading = h.run('reloadFromSite()');
  await tick();
  assert.equal(h.timers.has(timer), false);
  assert.deepEqual(calls, ['old draft']);
  first.resolve({ ok: true });
  await old;
  await reloading;
  assert.deepEqual(calls, ['old draft', 'from site']);
  assert.equal(h.state.draft.site.title, 'from site');
  assert.equal(h.state.dirty, false);
});

test('读取站点期间的新编辑会取消覆盖', async () => {
  const h = harness();
  const loading = deferred();
  const config = model.toConfigJson(h.state.draft);
  h.context.apiStub = () => loading.promise;
  h.run('api = apiStub;');
  const reloading = h.run('reloadFromSite()');
  h.run(`handlePatch({ kind: 'site', field: 'title', value: 'keep editing' })`);
  loading.resolve({ ok: true, config });
  await reloading;
  assert.equal(h.state.draft.site.title, 'keep editing');
  assert.equal(h.state.dirty, true);
});

test('旧图片完成不覆盖新维度底图，切维度取消取点与新建模式', async () => {
  const h = harness();
  h.run('state.placeFor = "point"; state.createArmed = true;');
  const a = h.run('activateDimension("a")');
  const b = h.run('activateDimension("b")');
  assert.equal(h.state.placeFor, null);
  assert.equal(h.state.createArmed, false);
  assert.equal(h.state.projection, null);
  h.images[1].naturalWidth = 200;
  h.images[1].naturalHeight = 100;
  h.images[1].onload();
  await b;
  h.images[0].naturalWidth = 300;
  h.images[0].naturalHeight = 100;
  h.images[0].onload();
  await a;
  const actual = h.paints.filter((p) => p.name === 'setImage' && p.args[0].src);
  assert.equal(actual.length, 1);
  assert.equal(actual[0].args[0].src, '/preview/b.png');
  assert.equal(h.state.projection.imageWidth, 200);
});

test('旧 manifest 失败不触发单图回退或污染当前维度', async () => {
  const h = harness();
  const manifest = deferred();
  h.state.draft.dimensions[0].tiles = { manifest: 'old/manifest.json' };
  h.state.tileModule = { loadTileset: () => manifest.promise };
  const a = h.run('activateDimension("a")');
  const b = h.run('activateDimension("b")');
  h.images[0].naturalWidth = 200;
  h.images[0].naturalHeight = 100;
  h.images[0].onload();
  await b;
  manifest.reject(new Error('stale manifest'));
  await a;
  assert.equal(h.images.length, 1);
  assert.equal(h.state.selection.dimensionId, 'b');
  assert.equal(h.state.projection.imageWidth, 200);
  assert.equal(h.state.draft.dimensions[0].tileMeta, undefined);
});

test('比例原点校准保留原值并按 flipZ 生成投影', () => {
  for (const flipZ of [false, true]) {
    const h = harness();
    const cal = { calibrated: true, xMin: null, xMax: null, zMin: null, zMax: null,
      pixelsPerBlock: 2, originX: -20, originZ: 80, flipZ };
    h.state.draft.dimensions[0].calibration = cal;
    h.run('ensureCalibration(currentDimension(), { width: 100, height: 100 }); syncAppProjection();');
    assert.equal(h.state.draft.dimensions[0].calibration, cal);
    assert.deepEqual(h.state.projection.imageToWorld(0, 0), { x: -20, z: 80 });
    assert.equal(h.state.projection.imageToWorld(100, 100).z, flipZ ? 30 : 130);
  }
});

test('撤销后同字段新编辑清掉重做且可再次撤销', async () => {
  const h = harness();
  h.run('activateDimension = async () => {};');
  const original = h.state.draft.site.title;
  h.run(`handlePatch({ kind: 'site', field: 'title', value: 'first' }); undo();
    handlePatch({ kind: 'site', field: 'title', value: 'second' });`);
  assert.equal(h.state.history.future.length, 0);
  h.run('undo()');
  assert.equal(h.state.draft.site.title, original);
});

test('地图新建可撤销，取点与地图新建互斥，空坐标不转成零', () => {
  const h = harness();
  h.run('activateDimension = async () => {};');
  const count = h.state.draft.dimensions[0].waypoints.length;
  h.run('createWaypointAt({ x: 30, z: 40 }); undo();');
  assert.equal(h.state.draft.dimensions[0].waypoints.length, count);
  h.run('state.createArmed = true; armPlacement("point", "point");');
  assert.equal(h.state.createArmed, false);
  assert.equal(h.run('coerce("x", "")'), null);
});

test('未持久化修改触发离页保护，持久化后不拦截', () => {
  const h = harness();
  h.run('bindKeyboard(); scheduleAutosave();');
  let blocked = 0;
  const event = { preventDefault: () => blocked++ };
  h.listeners.get('beforeunload')(event);
  assert.equal(blocked, 1);
  h.state.draftPending = false;
  h.listeners.get('beforeunload')(event);
  assert.equal(blocked, 1);
});

test('恢复的显式单图模式不会被站点瓦片配置补回', async () => {
  const h = harness();
  const draft = structuredClone(h.state.draft);
  const config = model.toConfigJson(draft);
  config.dimensions[0].tiles = { manifest: 'tiles/a/manifest.json' };
  h.context.apiStub = async (url) => url === '/api/state'
    ? { draft, configExists: true, siteExists: true, images: [], siteDir: 'fixture' }
    : { ok: true, config };
  h.elements.set('footer-site', {});
  h.run(`api = apiStub; loadSiteCoords = loadSiteTiles = async () => {};
    initPanel = initCanvas = () => {}; activateDimension = async () => {};`);
  await h.run('bootstrap()');
  assert.equal(h.state.draft.dimensions[0].tiles, null);
});
