const test = require('node:test');
const assert = require('node:assert/strict');

const { createAutoCodeRefreshService } = require('../src/runtime/auto-code-refresh');
const { getSchedulerRegistrySnapshot } = require('../src/services/scheduler');

function createService(account, logs, overrides = {}) {
  const accounts = [{ ...account }];
  const deps = {
    store: {
      getAutoCodeRefresh: () => ({ enabled: false, intervalMinutes: 60 }),
    },
    getAccounts: () => ({ accounts }),
    addOrUpdateAccount: (patch) => {
      const idx = accounts.findIndex(a => a.id === patch.id);
      if (idx >= 0) accounts[idx] = { ...accounts[idx], ...patch };
    },
    resolveWorkerControls: () => ({}),
    log: (...args) => logs.push(args),
    addAccountLog: () => {},
    ...overrides,
  };
  const service = createAutoCodeRefreshService(deps);
  service.__accounts = accounts;
  return service;
}

/** 取自动刷新命名空间下某个任务的快照 */
function taskSnapshot(name) {
  const snap = getSchedulerRegistrySnapshot('auto_code_refresh');
  const tasks = snap.schedulers[0] ? snap.schedulers[0].tasks : [];
  return tasks.find(task => task.name === name) || null;
}

test('QQ accounts do not emit a missing wxid warning during Code refresh scheduling', () => {
  const logs = [];
  const service = createService({ id: 'qq-1', name: 'QQ account', platform: 'qq' }, logs);

  service.scheduleAccount('qq-1');

  assert.deepEqual(logs, []);
});

test('WeChat accounts still report a missing wxid during Code refresh scheduling', () => {
  const logs = [];
  const service = createService({ id: 'wx-1', name: 'WeChat account', platform: 'wx' }, logs);

  service.scheduleAccount('wx-1');

  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], '自动刷新 Code 未启动: 账号缺少 wxid');
});

test('QQ handshake recovery never enters WeChat credential validation, even with leftover wx fields', async () => {
  for (const account of [
    { id: 'qq', platform: 'qq' },
    { id: 'qq', platform: 'qq', wxid: 'leftover', loginBuffer: 'leftover' },
  ]) {
    const logs = [];
    const service = createService(account, logs);
    assert.equal(await service.refreshAccountCode('qq', 'ws_400'), false);
    assert.equal(await service.refreshAccountCode('qq', 'manual'), false);
    assert.equal(service.scheduleRelogin('qq', 'ws_400'), false);
    assert.deepEqual(logs, []);
  }
});

test('disabled WeChat auto recovery does not attempt credential refresh', async () => {
  const logs = [];
  const service = createService({ id: 'wx', platform: 'wx' }, logs);
  assert.equal(await service.refreshAccountCode('wx', 'ws_400'), false);
  assert.deepEqual(logs, []);
  assert.equal(await service.refreshAccountCode('wx', 'manual'), false);
  assert.match(logs[0][1], /缺少 wxid/);
});

test('kickout recovery relogs in after 5 minutes instead of the Code refresh interval', () => {
  const logs = [];
  const service = createService(
    { id: 'wx-kick', name: '微信账号', platform: 'wx', wxid: 'openid-1', loginBuffer: 'buf' },
    logs,
    { store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) } },
  );

  assert.equal(service.scheduleRelogin('wx-kick', 'kickout:已在其他终端登录'), true);

  const task = taskSnapshot('relogin_wx-kick');
  assert.ok(task, '应注册重登任务');
  assert.equal(task.delayMs, 5 * 60 * 1000);
  assert.equal(service.KICKOUT_RELOGIN_DELAY_MIN, 5);
  assert.ok(
    logs.some(entry => /5 分钟后自动刷新凭证并重登/.test(String(entry[1]))),
    '日志应说明 5 分钟退避',
  );

  service.stopAccount('wx-kick');
});

test('pausing an account cancels its refresh/keepalive tasks and schedules a 30 minute resume', () => {
  const logs = [];
  const service = createService(
    { id: 'wx-pause', name: '微信账号', platform: 'wx', wxid: 'openid-2', loginBuffer: 'buf', refreshtoken: 'rt' },
    logs,
    { store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) } },
  );

  service.scheduleAccount('wx-pause');
  assert.ok(taskSnapshot('refresh_wx-pause'), '应先挂上 Code 刷新任务');

  assert.equal(service.pauseAccount('wx-pause'), true);

  assert.equal(taskSnapshot('refresh_wx-pause'), null, '暂停后不应再挂 Code 刷新');
  assert.equal(taskSnapshot('wx_keepalive_wx-pause'), null, '暂停后不应再挂凭据保活');
  const resume = taskSnapshot('resume_wx-pause');
  assert.ok(resume, '应注册恢复任务');
  assert.equal(resume.delayMs, 30 * 60 * 1000);

  const account = service.__accounts.find(a => a.id === 'wx-pause');
  assert.ok(account.pausedUntil > Date.now(), '应持久化暂停截止时间');
  assert.equal(service.isAccountPaused('wx-pause'), true);
  assert.ok(service.getPausedRemainingMs('wx-pause') > 0);

  service.stopAccount('wx-pause');
});

test('a paused account does not get Code refresh scheduling re-armed', () => {
  const logs = [];
  const service = createService(
    { id: 'wx-paused2', name: '微信账号', platform: 'wx', wxid: 'openid-3', loginBuffer: 'buf' },
    logs,
    { store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) } },
  );

  service.pauseAccount('wx-paused2');
  service.scheduleAccount('wx-paused2');

  assert.equal(taskSnapshot('refresh_wx-paused2'), null);
  assert.ok(logs.some(entry => /处于暂停状态/.test(String(entry[1]))));

  service.stopAccount('wx-paused2');
});

test('clearing the pause marker restores the account to a schedulable state', () => {
  const logs = [];
  const service = createService(
    { id: 'wx-clear', name: '微信账号', platform: 'wx', wxid: 'openid-4', loginBuffer: 'buf' },
    logs,
    { store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) } },
  );

  service.pauseAccount('wx-clear');
  assert.equal(service.isAccountPaused('wx-clear'), true);

  service.clearPause('wx-clear');
  assert.equal(service.isAccountPaused('wx-clear'), false);

  service.scheduleAccount('wx-clear');
  assert.ok(taskSnapshot('refresh_wx-clear'), '解除暂停后应重新挂上 Code 刷新');

  service.stopAccount('wx-clear');
});

test('pausing with a non positive delay only cancels tasks and does not schedule a resume', () => {
  const logs = [];
  const service = createService(
    { id: 'wx-del', name: '微信账号', platform: 'wx', wxid: 'openid-5', loginBuffer: 'buf' },
    logs,
  );

  assert.equal(service.pauseAccount('wx-del', 0), false);
  assert.equal(taskSnapshot('resume_wx-del'), null);
  assert.equal(service.isAccountPaused('wx-del'), false);

  service.stopAccount('wx-del');
});

test('换 Code 请求卡死时按超时失败处理，交给上层排退避重登', async () => {
  const logs = [];
  const service = createService(
    { id: 'wx-hang', name: '微信账号', platform: 'wx', wxid: 'openid-hang', loginBuffer: 'buf' },
    logs,
    {
      store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) },
      credentialRefreshTimeoutMs: 50,
    },
  );

  // 模拟凭据刷新请求永不返回（网络卡在应用宝）
  const wxLogin = require('../src/services/wx-login-adapter');
  const originalKeepAlive = wxLogin.keepWxCredentialAlive;
  const originalGetFarmCode = wxLogin.getFarmCode;
  wxLogin.keepWxCredentialAlive = async () => ({ Success: true });
  wxLogin.getFarmCode = () => new Promise(() => {});

  try {
    const ok = await service.refreshAccountCode('wx-hang', 'ws_400');
    assert.equal(ok, false, '卡死的刷新应按失败返回');
    assert.ok(
      logs.some(entry => /刷新凭证超时/.test(String(entry[1]))),
      '日志应记录刷新凭证超时',
    );
  }
  finally {
    wxLogin.keepWxCredentialAlive = originalKeepAlive;
    wxLogin.getFarmCode = originalGetFarmCode;
    service.stopAccount('wx-hang');
  }
});

test('恢复成功不消耗当日配额，配额不会被正常掉线烧光', async () => {
  const logs = [];
  const accountLogs = [];
  const service = createService(
    { id: 'wx-ok', name: '微信账号', platform: 'wx', wxid: 'openid-ok', loginBuffer: 'buf' },
    logs,
    {
      store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) },
      addAccountLog: (...args) => accountLogs.push(args),
    },
  );

  // 模拟「换到 Code 了」
  const wxLogin = require('../src/services/wx-login-adapter');
  const originalGetFarmCode = wxLogin.getFarmCode;
  wxLogin.getFarmCode = async () => ({ Success: true, Data: { code: 'fresh-code' } });

  try {
    // 连续 10 次「掉了又回来」：每次都是成功恢复
    for (let i = 0; i < 10; i++) {
      assert.equal(await service.refreshAccountCode('wx-ok', 'ws_400'), true);
    }
  }
  finally {
    wxLogin.getFarmCode = originalGetFarmCode;
  }

  // 配额没有被消耗，仍然可以正常排班重登
  assert.equal(service.scheduleRelogin('wx-ok', 'ws_400'), true);
  assert.equal(
    accountLogs.some(entry => /已达上限/.test(String(entry[1]))),
    false,
    '成功恢复不应触发上限降级',
  );

  service.stopAccount('wx-ok');
});

test('达到上限时降级为 30 分钟重试，而不是永久放弃', async () => {
  const logs = [];
  const accountLogs = [];
  const service = createService(
    { id: 'wx-degraded', name: '微信账号', platform: 'wx', wxid: 'openid-deg', loginBuffer: 'buf' },
    logs,
    {
      store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) },
      addAccountLog: (...args) => accountLogs.push(args),
    },
  );

  // 模拟连续失败：每次刷新都挂住/失败
  const wxLogin = require('../src/services/wx-login-adapter');
  const originalKeepAlive = wxLogin.keepWxCredentialAlive;
  const originalGetFarmCode = wxLogin.getFarmCode;
  wxLogin.keepWxCredentialAlive = async () => ({ Success: true });
  wxLogin.getFarmCode = () => { throw new Error('模拟失败'); };

  try {
    for (let i = 0; i < 6; i++) {
      await service.refreshAccountCode('wx-degraded', 'ws_400');
    }
    // 达到连续失败上限后仍能排班，只是间隔拉长到 30 分钟
    assert.equal(service.scheduleRelogin('wx-degraded', 'ws_400'), true);
    const task = taskSnapshot('relogin_wx-degraded');
    assert.ok(task, '降级后仍应注册重登任务');
    assert.equal(task.delayMs, 30 * 60 * 1000, '降级后应改用 30 分钟间隔');
    assert.ok(
      accountLogs.some(entry => /已达上限/.test(String(entry[1]))),
      '应记录降级原因',
    );
  }
  finally {
    wxLogin.keepWxCredentialAlive = originalKeepAlive;
    wxLogin.getFarmCode = originalGetFarmCode;
    service.stopAccount('wx-degraded');
  }
});
