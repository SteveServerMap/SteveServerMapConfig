/** In-memory controller regressions; no browser, server, or site writes.
 * Run: node --experimental-vm-modules --test tests/merge-controller.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import * as core from '../assets/js/merge-core.js';

const source = await readFile(new URL('../assets/js/merge.js', import.meta.url), 'utf8');
const dimension = (image = 'base.png', extra = {}) => ({
  id: image, image,
  calibration: { xMin: -4, xMax: 13, zMin: -12, zMax: 5, flipZ: false },
  ...extra,
});

async function controller(config = { dimensions: [dimension()] }) {
  const h = { config, requests: [], images: [], downloads: [], onConfigRead: null, onBlob: null };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: id.endsWith('-ppb') ? '1' : '', checked: true, dataset: {} });
    return elements.get(id);
  };
  class MockUI {
    constructor(root, callbacks) {
      this.callbacks = callbacks;
      this.params = { tileSize: 16, voidLuminance: 8, diffThreshold: 24 };
      h.ui = this;
    }
    setStatus(message, tone) { this.status = { message, tone }; }
    setBaseImage(payload) { this.base = payload; }
    setIncomingImage(payload) { this.incoming = payload; }
    setPickMarker(which, point) {
      const prefix = which === 'base' ? 'mg-base' : 'mg-inc';
      if (point) {
        element(`${prefix}-ox`).value = String(Math.round(point.px));
        element(`${prefix}-oy`).value = String(Math.round(point.py));
      }
      this[`${which}Pick`] = point;
    }
    setSaveName(name) { this.saveName = name; }
    getSaveName() { return this.saveName; }
    setAnalysis(value) { this.analysis = value; }
    setMergedPreview(value) { this.preview = value; }
    setBusy(value) { this.busy = value; }
    setParams(value) { Object.assign(this.params, value); }
    getParams() { return this.params; }
    getOptions() {
      return { fillNew: element('mg-opt-fill').checked, updateChanged: element('mg-opt-update').checked };
    }
    toast() {}
    focusOrigin() {}
  }
  class MockImage {
    naturalWidth = 17;
    naturalHeight = 17;
    set src(value) {
      h.images.push(value);
      this.data = new Uint8ClampedArray(17 * 17 * 4);
      for (let i = 0; i < this.data.length; i += 4) {
        this.data.set(value.includes('incoming') ? [200, 200, 200, 255] : [0, 0, 0, 255], i);
      }
      queueMicrotask(() => this.onload());
    }
  }
  const context = createContext({
    window: { addEventListener() {} },
    document: {
      getElementById: element,
      createElement(tag) {
        if (tag === 'a') return { click() { h.downloads.push(this.download); } };
        assert.equal(tag, 'canvas');
        let image;
        return {
          getContext: () => ({
            drawImage(value) { image = value; },
            getImageData: () => ({ data: image.data }),
            putImageData() {},
          }),
          toDataURL: () => 'data:image/png;base64,dGVzdA==',
          toBlob(resolve) { h.onBlob?.(); resolve({ size: 4 }); },
        };
      },
    },
    Image: MockImage,
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    URL: { createObjectURL: (blob) => `blob:${blob.name || 'output'}`, revokeObjectURL() {} },
    requestAnimationFrame: (callback) => queueMicrotask(callback),
    setTimeout() {},
    performance,
    console: { info() {}, warn() {}, error() {} },
    async fetch(path, options) {
      h.requests.push({ path, ...options });
      let data;
      if (path === '/api/state') data = { siteDir: 'in-memory', images: [] };
      else if (path === '/api/site-config') {
        await h.onConfigRead?.();
        data = h.config ? { ok: true, config: h.config } : { ok: false, error: 'config unavailable' };
      } else if (path === '/api/import-image') {
        const body = JSON.parse(options.body);
        data = { ok: true, name: body.fileName, bytes: 4 };
      } else assert.fail(`Unexpected request: ${path}`);
      return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    },
  });
  const module = new SourceTextModule(source, { context });
  await module.link((specifier) => {
    const exports = specifier === './merge-ui.js' ? { MergeUI: MockUI } : core;
    assert.ok(['./merge-ui.js', './merge-core.js'].includes(specifier));
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  await new Promise(setImmediate); // Settle bootstrap's in-memory fetch/image promises.
  return Object.assign(h, { merge: context.window.__merge, element });
}

async function prepareMerge(h) {
  if (!h.merge.base.image) await h.ui.callbacks.onBaseImage({ name: 'independent.png' });
  await h.ui.callbacks.onIncomingImage({ name: 'incoming.png' });
  h.merge.setPick('base', { px: 0, py: 0 });
  h.merge.setPick('incoming', { px: 0, py: 0 });
  await h.merge.analyze();
  assert.ok(h.merge.merged);
}

const writes = (h) => h.requests.filter((request) => request.path === '/api/import-image');

test('default base skips object/string tiles and shared fallback images', async () => {
  for (const tiles of [{ manifest: 'tiles/manifest.json' }, 'tiles/manifest.json']) {
    const h = await controller({ dimensions: [
      dimension('./Fallback.PNG', { tiles }), dimension('fallback.png'), dimension('image-only.png'),
    ] });
    assert.equal(h.merge.base.fileName, 'image-only.png');
    assert.deepEqual(h.images, ['/preview/image-only.png']);
    assert.match(h.ui.status.message, /主编辑器.*重新生成/);
  }
});

test('tiles-only site refuses fallback initialization but independent merging stays usable', async () => {
  const h = await controller({ dimensions: [dimension('fallback.png', { tiles: 'tiles/manifest.json' })] });
  assert.equal(h.merge.base.image, null);
  assert.equal(h.images.length, 0);
  assert.match(h.ui.status.message, /主编辑器.*重新生成瓦片/);
  await prepareMerge(h);
  await h.merge.download();
  await h.merge.save();
  assert.deepEqual(h.downloads, ['independent.png']);
  assert.equal(writes(h).length, 1);
});

test('empty tiles metadata still permits image-only initialization', async () => {
  for (const tiles of [null, '', {}, { manifest: ' ' }]) {
    const h = await controller({ dimensions: [dimension('base.png', { tiles })] });
    assert.equal(h.merge.base.fileName, 'base.png');
  }
});

test('origin inputs reflect bounds and edits preserve flipZ on either side', async () => {
  for (const flipZ of [false, true]) {
    const h = await controller({ dimensions: [dimension('base.png', {
      calibration: { xMin: -4, xMax: 13, zMin: -12, zMax: 5, flipZ },
    })] });
    assert.equal(h.element('mg-base-ox').value, '4');
    assert.equal(h.element('mg-base-oy').value, flipZ ? '5' : '12');
    assert.equal(h.element('mg-base-ppb').value, '1');
    await h.ui.callbacks.onIncomingImage({ name: 'incoming.png' });
    h.merge.setCalibration('incoming', h.merge.base.cal);
    for (const side of ['base', 'incoming']) {
      h.merge.setPpb(side, 2);
      assert.equal(h.merge[side].cal.flipZ, flipZ);
      assert.equal(h.merge[side].cal.xMin, -2);
      assert.equal(h.merge[side].cal.zMax, 2.5);
      h.merge.setOriginPx(side, { px: 6, py: 7 });
      assert.equal(h.merge[side].cal.flipZ, flipZ);
      assert.deepEqual(core.worldToPixel(h.merge[side].cal, 0, 0), { px: 6, py: 7 });
    }
  }
});

test('loading custom images clears old origins; blank scale-change inputs are not zero', async () => {
  const h = await controller();
  for (const side of ['base', 'incoming']) {
    const load = side === 'base' ? h.ui.callbacks.onBaseImage : h.ui.callbacks.onIncomingImage;
    const prefix = side === 'base' ? 'mg-base' : 'mg-inc';
    await load({ name: `${side}.png` });
    h.merge.setPick(side, { px: 3, py: 4 });
    await load({ name: `replacement-${side}.png` });
    assert.equal(h.element(`${prefix}-ox`).value, '');
    assert.equal(h.element(`${prefix}-oy`).value, '');
    assert.equal(h.ui[`${side}Pick`], null);
    for (const [ox, oy] of [['', ''], ['', '2'], ['2', '   ']]) {
      h.element(`${prefix}-ox`).value = ox;
      h.element(`${prefix}-oy`).value = oy;
      h.merge.setPpb(side, 2);
      assert.equal(h.merge[side].cal, null);
    }
    h.element(`${prefix}-ox`).value = '0';
    h.element(`${prefix}-oy`).value = '0';
    h.merge.setPpb(side, 2);
    assert.ok(h.merge[side].cal);
    assert.equal(h.merge[side].cal.xMin, 0);
  }
});

test('every analysis parameter change clears output and blocks compose/save/download until reanalysis', async () => {
  const h = await controller();
  await prepareMerge(h);
  for (const params of [{ diffThreshold: 200 }, { voidLuminance: 250 }, { tileSize: 8 }]) {
    h.merge.setParams(params);
    assert.equal(h.merge.state.analysisStale, true);
    assert.equal(h.merge.analysis, null);
    assert.equal(h.merge.merged, null);
    assert.equal(h.ui.analysis, null);
    assert.equal(h.ui.preview, null);
    h.merge.compose();
    h.merge.setOptions({ fillNew: false });
    await h.merge.download();
    await h.merge.save();
    assert.equal(h.merge.merged, null);
    assert.equal(writes(h).length, 0);
    assert.equal(h.downloads.length, 0);
    await h.merge.analyze();
    assert.equal(h.merge.state.analysisStale, false);
    assert.ok(h.merge.merged);
  }
});

test('strategy changes recompose; calibration changes invalidate the result', async () => {
  const h = await controller();
  await prepareMerge(h);
  assert.ok(h.merge.merged.applied.filledTiles > 0);
  h.merge.setOptions({ fillNew: false, updateChanged: false });
  assert.equal(h.merge.merged.applied.filledTiles, 0);
  h.merge.setOriginPx('incoming', { px: 1, py: 1 });
  assert.equal(h.merge.merged, null);
  await h.merge.save();
  assert.equal(writes(h).length, 0);
});

test('save checks fresh config and blocks all tile fallback names, regardless of selected base', async () => {
  for (const tiles of ['tiles/manifest.json', { manifest: 'tiles/manifest.json' }]) {
    const h = await controller();
    await prepareMerge(h);
    h.config.dimensions.push(dimension('./Fallback.PNG', { tiles }));
    h.merge.setSaveName('fallback.png');
    await h.merge.save();
    assert.equal(writes(h).length, 0);
    assert.match(h.ui.status.message, /主编辑器.*重新生成瓦片/);
    assert.ok(h.merge.merged, 'a blocked save should still allow independent export');
    await h.merge.download();
    assert.equal(h.downloads.length, 1);
    h.merge.setSaveName('independent.png');
    await h.merge.save();
    assert.equal(writes(h).length, 1);
  }
});

test('enabling tiles for the selected base after initialization also blocks overwrite', async () => {
  const h = await controller();
  await prepareMerge(h);
  h.config.dimensions[0].tiles = { manifest: 'tiles/new-manifest.json' };
  await h.merge.save();
  assert.equal(writes(h).length, 0);
  assert.match(h.ui.status.message, /回退图/);
});

test('invalid scale changes invalidate output without inventing a new calibration', async () => {
  const h = await controller();
  await prepareMerge(h);
  const cal = h.merge.base.cal;
  h.merge.setPpb('base', '');
  assert.equal(h.merge.base.cal, cal);
  assert.equal(h.merge.merged, null);
  h.merge.compose();
  await h.merge.download();
  await h.merge.save();
  assert.equal(h.downloads.length, 0);
  assert.equal(writes(h).length, 0);
});

test('failed config verification prevents writes without preventing downloads', async () => {
  const h = await controller();
  await prepareMerge(h);
  for (const config of [null, {}]) {
    h.config = config;
    await h.merge.save();
    assert.equal(writes(h).length, 0);
    assert.equal(h.ui.status.tone, 'error');
  }
  await h.merge.download();
  assert.equal(h.downloads.length, 1);
});

test('invalidations during asynchronous export/config checks cancel stale output', async () => {
  const h = await controller();
  await prepareMerge(h);
  h.onBlob = () => h.merge.setParams({ tileSize: 8 });
  await h.merge.download();
  assert.equal(h.downloads.length, 0);
  await h.merge.analyze();
  h.onConfigRead = () => h.merge.setParams({ diffThreshold: 30 });
  await h.merge.save();
  assert.equal(writes(h).length, 0);
});

test('a failed reanalysis cannot leave the previous merged output available', async () => {
  const h = await controller();
  await prepareMerge(h);
  h.merge.state.incoming.cal = { ...h.merge.incoming.cal, xMin: 1000, xMax: 1017 };
  await h.merge.analyze();
  assert.equal(h.merge.merged, null);
  await h.merge.download();
  await h.merge.save();
  assert.equal(h.downloads.length, 0);
  assert.equal(writes(h).length, 0);
});
