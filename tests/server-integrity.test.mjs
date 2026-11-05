import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../tools/xaero-decode.mjs';

const TEST_FILE = fileURLToPath(import.meta.url);
const config = (version, count = 0) => ({
  version,
  dimensions: [{ id: 'world', waypoints: Array.from({ length: count }, (_, id) => ({ id })) }],
});
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

// Fault injection lives only in this disposable child process, not in production code.
async function runServerChild() {
  const faults = [];
  const gates = new Map();
  const original = Object.fromEntries(['open', 'rename', 'rm', 'copyFile', 'writeFile'].map((key) => [key, fs[key].bind(fs)]));
  const injected = (fault) => Object.assign(new Error(`Injected ${fault.operation} failure`), { code: 'EIO' });
  const take = (operation, from, to) => {
    const index = faults.findIndex((fault) => fault.operation === operation
      && (!fault.fromIncludes || String(from).includes(fault.fromIncludes))
      && (!fault.to || String(to) === fault.to));
    return index < 0 ? null : faults.splice(index, 1)[0];
  };
  const apply = async (fault) => {
    if (!fault) return;
    if (fault.effect !== 'pause') throw injected(fault);
    await new Promise((resolve) => {
      gates.set(fault.id, resolve);
      process.send({ type: 'blocked', id: fault.id });
    });
    gates.delete(fault.id);
  };
  process.on('message', (message) => {
    if (message.action === 'arm') faults.push(message.fault);
    if (message.action === 'release') gates.get(message.gate)?.();
    process.send({ type: 'ack', id: message.id });
  });
  for (const operation of ['rename', 'rm', 'copyFile']) {
    fs[operation] = async (...args) => {
      const fault = take(operation, args[0], args[1]);
      if (fault?.effect === 'collision') {
        await original.writeFile(args[1], 'existing backup', { flag: 'wx' });
      } else {
        await apply(fault);
      }
      if (operation === 'copyFile') process.send({ type: 'copy', to: args[1], flags: args[2] });
      const result = await original[operation](...args);
      process.send({ type: 'mutation', operation, from: args[0], to: operation === 'rename' ? args[1] : undefined });
      return result;
    };
  }
  fs.open = async (...args) => {
    const handle = await original.open(...args);
    process.send({ type: 'open', path: args[0], flags: args[1] });
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...writeArgs) => {
      const fault = take('write', args[0]);
      if (fault?.effect === 'partial') {
        await write(String(writeArgs[0]).slice(0, 7), 'utf8');
        throw injected(fault);
      }
      await apply(fault);
      return write(...writeArgs);
    };
    return handle;
  };
  const createServer = http.createServer;
  http.createServer = (...args) => {
    const server = createServer(...args);
    server.on('listening', () => process.send({ type: 'ready', port: server.address().port }));
    server.on('request', (req) => process.send({ type: 'request', method: req.method, url: req.url }));
    return server;
  };
  if (process.argv.includes('--fixed-clock')) {
    const NativeDate = Date;
    const fixed = NativeDate.parse('2026-01-01T12:00:00.000Z');
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed; }
    };
  }
  await import(new URL('../server.mjs', import.meta.url));
}

async function startServer(t, { fixedClock = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ssm-server-integrity-'));
  const site = path.join(root, 'site');
  const data = path.join(root, 'data');
  const xaero = path.join(root, 'xaero');
  for (const dir of [site, data, xaero]) await fs.mkdir(dir);
  const configFile = path.join(site, 'config.json');
  const draftFile = path.join(data, 'draft.json');
  await fs.writeFile(configFile, JSON.stringify(config(0)) + '\n');
  await fs.writeFile(draftFile, JSON.stringify({ version: 0 }) + '\n');
  const child = fork(TEST_FILE, [
    '--integrity-server', `--site=${site}`, `--data=${data}`, `--xaero=${xaero}`,
    '--host=127.0.0.1', '--port=0', ...(fixedClock ? ['--fixed-clock'] : []),
  ], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = [];
  const pending = new Set();
  const requests = new Set();
  let output = '';
  let exited = false;
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => {
    exited = true;
    for (const waiter of pending) waiter.reject(new Error(`Server exited (${code || signal}):\n${output}`));
    resolve();
  }));
  child.on('message', (message) => {
    messages.push(message);
    for (const waiter of pending) {
      if (waiter.match(message)) waiter.resolve(message);
    }
  });
  const waitFor = (match) => {
    const previous = messages.find(match);
    if (previous) return Promise.resolve(previous);
    if (exited) return Promise.reject(new Error(`Server exited:\n${output}`));
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        clearTimeout(timer);
        pending.delete(waiter);
        callback(value);
      };
      const waiter = { match, resolve: (value) => finish(resolve, value), reject: (err) => finish(reject, err) };
      const timer = setTimeout(() => waiter.reject(new Error(`Timed out waiting for server:\n${output}`)), 10000);
      pending.add(waiter);
    });
  };
  t.after(async () => {
    for (const request of requests) request.destroy();
    if (!exited) child.kill();
    await exit;
    await fs.rm(root, { recursive: true, force: true });
  });
  const { port } = await waitFor((message) => message.type === 'ready');
  let serial = 0;
  async function control(action, extra = {}) {
    const id = ++serial;
    child.send({ action, id, ...extra });
    await waitFor((message) => message.type === 'ack' && message.id === id);
    return id;
  }
  async function arm(fault) {
    const id = ++serial;
    await control('arm', { fault: { id, effect: 'fail', ...fault } });
    return id;
  }
  function begin(method, url, body, delayed = false) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1', port, method, path: url, agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) },
    });
    requests.add(request);
    request.once('close', () => requests.delete(request));
    const reply = new Promise((resolve, reject) => {
      request.on('error', reject);
      request.on('response', (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { raw += chunk; });
        response.on('error', reject);
        response.on('end', () => {
          try { resolve({ status: response.statusCode, body: JSON.parse(raw) }); }
          catch (err) { reject(err); }
        });
      });
    });
    reply.catch(() => {});
    request.flushHeaders();
    if (!delayed) request.end(text);
    return {
      reply, end: () => request.end(text),
      arrived: waitFor((message) => message.type === 'request' && message.method === method && message.url === url),
    };
  }
  const api = (method, url, body) => begin(method, url, body).reply;
  const health = async () => {
    const reply = await api('GET', '/api/health');
    assert.equal(reply.status, 200);
    assert.equal(reply.body.siteDir, site);
    assert.equal(exited, false);
  };
  return {
    site, data, xaero, configFile, draftFile, messages, api, begin, arm, health,
    blocked: (id) => waitFor((message) => message.type === 'blocked' && message.id === id),
    release: (id) => control('release', { gate: id }),
  };
}

async function assertNoTemps(dir) {
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.includes('.tmp-')), []);
}

async function tileFixture(server, existing = true) {
  const source = path.join(server.xaero, 'fixture');
  const tiles = path.join(server.site, 'tiles');
  const out = path.join(tiles, 'world');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'x0_z0.png'), encodePng(64, 64, Buffer.alloc(64 * 64 * 4, 255)));
  await fs.mkdir(tiles);
  if (existing) {
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, 'old-tile.png'), 'original tile bytes');
    await fs.writeFile(path.join(out, 'manifest.json'), '{"original":true}\n');
  }
  return {
    source, tiles, out,
    generate: () => server.api('POST', '/api/xaero/generate', { folder: 'fixture', dimensionId: 'world', tileSize: 64 }),
  };
}

if (process.argv.includes('--integrity-server')) {
  await runServerChild();
} else {
  test('rapid saves retain distinct backups and keep the latest ten versions', async (t) => {
    const s = await startServer(t, { fixedClock: true });
    const backups = [];
    for (let version = 1; version <= 12; version += 1) {
      const reply = await s.api('POST', '/api/save', { config: config(version) });
      assert.equal(reply.status, 200);
      assert.equal(reply.body.ok, true);
      assert.equal(reply.body.path, s.configFile);
      assert.equal(reply.body.bytes, Buffer.byteLength(JSON.stringify(config(version), null, 2) + '\n'));
      assert.ok(reply.body.savedAt);
      backups.push(reply.body.backup);
      assert.equal((await readJson(path.join(s.site, reply.body.backup))).version, version - 1);
      if (version === 8) {
        assert.equal((await fs.readdir(path.join(s.site, '.backups'))).length, 8);
      }
    }
    assert.equal(new Set(backups).size, 12);
    const retained = await fs.readdir(path.join(s.site, '.backups'));
    const versions = await Promise.all(retained.map(async (name) => (await readJson(path.join(s.site, '.backups', name))).version));
    assert.deepEqual(versions.sort((a, b) => a - b), Array.from({ length: 10 }, (_, i) => i + 2));
    assert.equal((await readJson(s.configFile)).version, 12);
    assert.ok(s.messages.filter((message) => message.type === 'copy').every((message) => message.flags === constants.COPYFILE_EXCL));
  });

  test('save and draft mutations share invocation order even with a delayed first body', async (t) => {
    const s = await startServer(t);
    const first = s.begin('POST', '/api/save?order=1', { config: config(1) }, true);
    await first.arrived;
    const put = s.begin('PUT', '/api/draft?order=2', { draft: { version: 1 } });
    await put.arrived;
    const remove = s.begin('DELETE', '/api/draft?order=3');
    await remove.arrived;
    const last = s.begin('POST', '/api/save?order=4', { config: config(2) });
    await last.arrived;
    await s.health();
    assert.equal((await readJson(s.configFile)).version, 0);
    assert.equal((await readJson(s.draftFile)).version, 0);
    first.end();
    assert.deepEqual((await Promise.all([first.reply, put.reply, remove.reply, last.reply])).map((reply) => reply.status), [200, 200, 200, 200]);
    assert.equal((await readJson(s.configFile)).version, 2);
    await assert.rejects(fs.readFile(s.draftFile), { code: 'ENOENT' });
    const mutations = s.messages.filter((message) => message.type === 'mutation'
      && (message.to === s.configFile || message.to === s.draftFile || message.from === s.draftFile));
    assert.deepEqual(mutations.map((message) => [message.operation, message.to || message.from]), [
      ['rename', s.configFile], ['rename', s.draftFile], ['rm', s.draftFile], ['rename', s.configFile],
    ]);
  });

  test('a slow draft PUT cannot resurrect a later DELETE', async (t) => {
    const s = await startServer(t);
    const put = s.begin('PUT', '/api/draft?slow', { draft: { version: 1 } }, true);
    await put.arrived;
    const remove = s.begin('DELETE', '/api/draft?after');
    await remove.arrived;
    await s.health();
    put.end();
    assert.equal((await put.reply).status, 200);
    assert.equal((await remove.reply).status, 200);
    await assert.rejects(fs.readFile(s.draftFile), { code: 'ENOENT' });
    assert.equal((await s.api('PUT', '/api/draft', { draft: { version: 2 } })).status, 200);
    assert.equal((await readJson(s.draftFile)).version, 2);
  });

  test('deletion confirmation checks the latest queued save and still requires confirmation', async (t) => {
    const s = await startServer(t);
    const gate = await s.arm({ operation: 'rename', to: s.configFile, effect: 'pause' });
    const first = s.begin('POST', '/api/save?first', { config: config(1, 10) });
    await s.blocked(gate);
    const second = s.begin('POST', '/api/save?second', { config: config(2) });
    await second.arrived;
    await s.release(gate);
    assert.equal((await first.reply).status, 200);
    const refused = await second.reply;
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'CONFIRM_REQUIRED');
    assert.equal(refused.body.before.total, 10);
    assert.equal(refused.body.after.total, 0);
    assert.deepEqual(await readJson(s.configFile), config(1, 10));
    const confirmed = await s.api('POST', '/api/save', { config: config(2), confirm: true });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(await readJson(path.join(s.site, confirmed.body.backup)), config(1, 10));
  });

  test('a queued malformed body neither crashes nor lets later mutations overtake', async (t) => {
    const s = await startServer(t);
    const gate = await s.arm({ operation: 'rename', to: s.configFile, effect: 'pause' });
    const first = s.begin('POST', '/api/save?first', { config: config(1) });
    await s.blocked(gate);
    const invalid = s.begin('PUT', '/api/draft?invalid', '{');
    await invalid.arrived;
    const last = s.begin('POST', '/api/save?last', { config: config(2) });
    await last.arrived;
    await s.health();
    assert.deepEqual(await readJson(s.configFile), config(0));
    await s.release(gate);
    assert.deepEqual((await Promise.all([first.reply, invalid.reply, last.reply])).map((reply) => reply.status), [200, 400, 200]);
    assert.deepEqual(await readJson(s.configFile), config(2));
  });

  for (const kind of ['config', 'draft']) {
    test(`${kind} is visible only after its same-directory atomic rename`, async (t) => {
      const s = await startServer(t);
      const file = kind === 'config' ? s.configFile : s.draftFile;
      const value = kind === 'config' ? config(1) : { version: 1 };
      const before = await fs.readFile(file, 'utf8');
      const gate = await s.arm({ operation: 'rename', to: file, effect: 'pause' });
      const request = kind === 'config'
        ? s.api('POST', '/api/save', { config: value })
        : s.api('PUT', '/api/draft', { draft: value });
      await s.blocked(gate);
      assert.equal(await fs.readFile(file, 'utf8'), before);
      const opened = s.messages.find((message) => message.type === 'open');
      assert.equal(opened.flags, 'wx');
      assert.equal(path.dirname(opened.path), path.dirname(file));
      assert.deepEqual(await readJson(opened.path), value);
      const read = await s.api('GET', kind === 'config' ? '/api/site-config' : '/api/state');
      assert.deepEqual(read.body[kind], JSON.parse(before));
      await s.release(gate);
      assert.equal((await request).status, 200);
      assert.deepEqual(await readJson(file), value);
      await assertNoTemps(path.dirname(file));
    });

    for (const operation of ['write', 'rename']) {
      test(`${kind} survives ${operation} failure with temporary-file cleanup and queue recovery`, async (t) => {
        const s = await startServer(t);
        const file = kind === 'config' ? s.configFile : s.draftFile;
        const before = await fs.readFile(file, 'utf8');
        await s.arm(operation === 'write'
          ? { operation, fromIncludes: `.${path.basename(file)}.tmp-`, effect: 'partial' }
          : { operation, to: file });
        const save = () => kind === 'config'
          ? s.api('POST', '/api/save', { config: config(1) })
          : s.api('PUT', '/api/draft', { draft: { version: 1 } });
        const reply = await save();
        assert.equal(reply.status, 500);
        assert.match(reply.body.error, /Injected/);
        assert.equal(await fs.readFile(file, 'utf8'), before);
        await assertNoTemps(path.dirname(file));
        assert.equal((await save()).status, 200);
        assert.equal((await readJson(file)).version, 1);
      });
    }
  }

  test('exclusive backup copy refuses a collision without overwriting either version', async (t) => {
    const s = await startServer(t);
    await s.arm({ operation: 'copyFile', effect: 'collision' });
    const failed = await s.api('POST', '/api/save', { config: config(1) });
    assert.equal(failed.status, 500);
    assert.deepEqual(await readJson(s.configFile), config(0));
    const copy = s.messages.find((message) => message.type === 'copy');
    assert.equal(copy.flags, constants.COPYFILE_EXCL);
    assert.equal(await fs.readFile(copy.to, 'utf8'), 'existing backup');
    assert.equal((await s.api('POST', '/api/save', { config: config(2) })).status, 200);
  });

  test('malformed URL encodings return errors without a finish-logger crash', async (t) => {
    const s = await startServer(t);
    for (const url of ['/assets/%', '/preview/%E0%A4%A', '/api/%FF']) {
      const reply = await s.api('GET', url);
      assert.equal(reply.status, 400);
      assert.equal(reply.body.ok, false);
      await s.health();
    }
  });

  for (const existing of [false, true]) {
    test(`tile publication succeeds ${existing ? 'over an existing directory' : 'without an old directory'}`, async (t) => {
      const s = await startServer(t);
      const tiles = await tileFixture(s, existing);
      const reply = await tiles.generate();
      assert.equal(reply.status, 200);
      assert.equal(reply.body.manifest, 'tiles/world/manifest.json');
      assert.equal(reply.body.outDir, 'tiles/world');
      assert.equal(reply.body.stats.tilesWritten, 1);
      assert.equal((await readJson(path.join(tiles.out, 'manifest.json'))).source, 'xaero-folder');
      assert.deepEqual(await fs.readdir(tiles.tiles), ['world']);
      await assert.rejects(fs.readFile(path.join(tiles.out, 'old-tile.png')), { code: 'ENOENT' });
    });
  }

  for (const stage of ['generation', 'move-old', 'publish', 'rollback', 'cleanup']) {
    test(`tile ${stage} failure preserves recoverable old data`, async (t) => {
      const s = await startServer(t);
      const tiles = await tileFixture(s);
      if (stage === 'generation') {
        // Keep a recognizable PNG header, but remove compressed image data.
        const png = path.join(tiles.source, 'x0_z0.png');
        await fs.writeFile(png, (await fs.readFile(png)).subarray(0, 33));
      } else if (stage === 'move-old') {
        await s.arm({ operation: 'rename', fromIncludes: tiles.out });
      } else if (stage === 'cleanup') {
        await s.arm({ operation: 'rm', fromIncludes: '.bak-world-' });
      } else {
        await s.arm({ operation: 'rename', fromIncludes: '.tmp-world-', to: tiles.out });
        if (stage === 'rollback') await s.arm({ operation: 'rename', fromIncludes: '.bak-world-', to: tiles.out });
      }
      const reply = await tiles.generate();
      assert.equal(reply.status, stage === 'cleanup' ? 200 : 500);
      await assertNoTemps(tiles.tiles);
      const entries = await fs.readdir(tiles.tiles);
      let preserved = tiles.out;
      if (stage === 'rollback' || stage === 'cleanup') {
        const backups = entries.filter((name) => name.startsWith('.bak-world-'));
        assert.equal(backups.length, 1);
        preserved = path.join(tiles.tiles, backups[0]);
        if (stage === 'rollback') {
          assert.ok(reply.body.error.includes(preserved));
          await assert.rejects(fs.stat(tiles.out), { code: 'ENOENT' });
        } else {
          assert.equal((await readJson(path.join(tiles.out, 'manifest.json'))).source, 'xaero-folder');
        }
      } else {
        assert.deepEqual(entries, ['world']);
      }
      assert.equal(await fs.readFile(path.join(preserved, 'old-tile.png'), 'utf8'), 'original tile bytes');
      assert.deepEqual(await readJson(path.join(preserved, 'manifest.json')), { original: true });
      await s.health();
    });
  }
}
