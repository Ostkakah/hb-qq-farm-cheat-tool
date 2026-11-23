const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createWorkerManager } = require('../src/runtime/worker-manager');

/**
 * 构造一个最小可用的 worker-manager 测试夹具。
 * refreshAccountCode / scheduleAutoRelogin 都可注入，用来观察恢复链路。
 */
function createHarness(t, options = {}) {
  const proc = new EventEmitter();
  proc.send = () => {};
  proc.kill = () => {};
  const workers = {};
  const refreshCalls = [];
  const reloginCalls = [];
  const refreshResults = options.refreshResults || [true];

  let refreshIndex = 0;
  const manager = createWorkerManager({
    fork: () => proc,
    runtimeMode: 'fork',
    processRef: { pkg: false, env: {}, execPath: process.execPath },
    mainEntryPath: '',
    workerScriptPath: '',
    workers,
    globalLogs: [],
    log: () => {},
    addAccountLog: () => {},
    normalizeStatusForPanel: value => value,
    buildConfigSnapshotForAccount: () => ({}),
    getOfflineAutoDeleteMs: () => Infinity,
    triggerOfflineReminder: () => {},
    addOrUpdateAccount: () => {},
    getAccounts: () => ({ accounts: options.accounts || [] }),
    deleteAccount: () => {},
    refreshAccountCode: (accountId, reason) => {
      refreshCalls.push({ accountId, reason });
      const result = refreshResults[Math.min(refreshIndex, refreshResults.length - 1)];
      refreshIndex += 1;
      return Promise.resolve(result);
    },
    scheduleAutoRelogin: (accountId, reason) => {
      reloginCalls.push({ accountId, reason });
      return true;
    },
    isReloginPending: () => false,
  });
  t.after(() => manager.dispose());
  manager.startWorker({ id: 'a1', name: '测试账号', username: 'owner', code: 'code' });
  return { proc, workers, refreshCalls, reloginCalls };
}

test('WS 400 登录失效会立即刷新 Code', async (t) => {
  const { proc, refreshCalls } = createHarness(t);
  proc.emit('message', { type: 'ws_error', code: 400, message: 'token expired' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].accountId, 'a1');
  assert.equal(refreshCalls[0].reason, 'ws_400');
});

test('刷新失败时排退避重登', async (t) => {
  const { proc, reloginCalls } = createHarness(t, { refreshResults: [false] });
  proc.emit('message', { type: 'ws_error', code: 400, message: 'token expired' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(reloginCalls.length, 1);
  assert.equal(reloginCalls[0].accountId, 'a1');
  assert.equal(reloginCalls[0].reason, 'ws_400_refresh_failed');
});

test('踢下线会排退避重登并带上原因', async (t) => {
  const { proc, reloginCalls } = createHarness(t);
  proc.emit('message', { type: 'account_kicked', reason: '已在其他终端登录' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(reloginCalls.length, 1);
  assert.equal(reloginCalls[0].reason, 'kickout:已在其他终端登录');
});

test('已有刷新在飞时再来 WS 400，恢复链不能被静默吞掉', async (t) => {
  // 复现线上故障：换 Code 的网络请求卡住不返回（promise 永不 settle），
  // 此时又来一次 ws_400。旧实现会因为「已有刷新在飞」直接跳过整条恢复分支，
  // 于是既不刷 Code 也不排退避重登，账号就一直离线到进程重启。
  let releaseRefresh = () => {};
  const refreshCalls = [];
  const reloginCalls = [];

  const proc = new EventEmitter();
  proc.send = () => {};
  proc.kill = () => {};
  const workers = {};
  const manager = createWorkerManager({
    fork: () => proc,
    runtimeMode: 'fork',
    processRef: { pkg: false, env: {}, execPath: process.execPath },
    mainEntryPath: '',
    workerScriptPath: '',
    workers,
    globalLogs: [],
    log: () => {},
    addAccountLog: () => {},
    normalizeStatusForPanel: value => value,
    buildConfigSnapshotForAccount: () => ({}),
    getOfflineAutoDeleteMs: () => Infinity,
    triggerOfflineReminder: () => {},
    addOrUpdateAccount: () => {},
    getAccounts: () => ({ accounts: [] }),
    deleteAccount: () => {},
    refreshAccountCode: (accountId, reason) => {
      refreshCalls.push({ accountId, reason });
      if (refreshCalls.length === 1) {
        // 第一次刷新挂住，模拟网络卡死
        return new Promise((resolve) => { releaseRefresh = () => resolve(false); });
      }
      return Promise.resolve(false);
    },
    scheduleAutoRelogin: (accountId, reason) => {
      reloginCalls.push({ accountId, reason });
      return true;
    },
    isReloginPending: () => false,
  });
  t.after(() => manager.dispose());
  manager.startWorker({ id: 'a1', name: '测试账号', username: 'owner', code: 'code' });

  proc.emit('message', { type: 'ws_error', code: 400, message: 'token expired' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshCalls.length, 1, '第一次 ws_400 应触发一次刷新');

  // 刷新还在飞，此时又来一次 ws_400
  proc.emit('message', { type: 'ws_error', code: 400, message: 'token expired' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshCalls.length, 1, '刷新在飞时不应重复发起刷新');

  // 在飞的刷新最终失败 → 必须排退避重登，否则账号永久离线
  releaseRefresh();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(reloginCalls.length >= 1, '在飞刷新失败后应排退避重登');
  assert.ok(
    reloginCalls.some(call => call.accountId === 'a1'),
    '重登应挂在该账号上',
  );
});
