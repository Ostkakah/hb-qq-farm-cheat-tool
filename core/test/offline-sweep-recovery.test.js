// 巡检间隔/宽限期做成可配置，测试里用毫秒级代替真实等待。
process.env.FARM_OFFLINE_SWEEP_INTERVAL_MS = '30';
process.env.FARM_OFFLINE_SWEEP_GRACE_MS = '10';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createWorkerManager } = require('../src/runtime/worker-manager');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 复现线上故障：账号掉线后，兜底巡检每 2 分钟排一次恢复，
 * 把待执行的重登倒计时无限重置，账号永远回不来。
 */
function createHarness(t, options = {}) {
    const proc = new EventEmitter();
    proc.send = () => {};
    proc.kill = () => {};
    const workers = {};
    const reloginCalls = [];
    const pending = new Set();
    const account = {
        id: 'a1', name: '大号', username: 'owner', platform: 'wx',
        wxid: 'openid-1', loginBuffer: 'buf',
    };

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
        getAccounts: () => ({ accounts: [account] }),
        deleteAccount: () => {},
        store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) },
        scheduleAutoRelogin: (accountId, reason) => {
            reloginCalls.push({ accountId, reason });
            pending.add(accountId);
            return options.scheduleReturns !== false;
        },
        isReloginPending: accountId => pending.has(accountId),
    });
    t.after(() => manager.dispose());
    return { proc, workers, reloginCalls, pending, manager };
}

test('账号离线后巡检会安排一次自动恢复', async (t) => {
    const h = createHarness(t);
    // 不启动 worker → 账号处于离线状态
    await sleep(200);

    assert.ok(h.reloginCalls.length >= 1, '离线后应安排自动恢复');
    assert.equal(h.reloginCalls[0].accountId, 'a1');
    assert.equal(h.reloginCalls[0].reason, 'offline_sweep');
});

test('已有重登在排队时巡检不会重复排班（否则倒计时被重置，账号永远回不来）', async (t) => {
    const h = createHarness(t);
    await sleep(200);

    const first = h.reloginCalls.length;
    assert.ok(first >= 1, '应至少排过一次');

    // 再等几轮：pending 一直没清（重登还没到点执行）
    await sleep(300);

    assert.equal(
        h.reloginCalls.length,
        first,
        '重登待执行期间不应重复排班，否则 5 分钟倒计时会被无限重置',
    );
});

test('排班被拒时如实记录，不谎报已安排恢复', async (t) => {
    const logs = [];
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
        log: (...args) => logs.push(args),
        addAccountLog: () => {},
        normalizeStatusForPanel: value => value,
        buildConfigSnapshotForAccount: () => ({}),
        getOfflineAutoDeleteMs: () => Infinity,
        triggerOfflineReminder: () => {},
        addOrUpdateAccount: () => {},
        getAccounts: () => ({
            accounts: [{
                id: 'a1', name: '大号', username: 'owner', platform: 'wx',
                wxid: 'openid-1', loginBuffer: 'buf',
            }],
        }),
        deleteAccount: () => {},
        store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) },
        scheduleAutoRelogin: () => false,
        isReloginPending: () => false,
    });
    t.after(() => manager.dispose());

    await sleep(200);

    const messages = logs.map(entry => String(entry[1] || ''));
    assert.ok(
        messages.some(msg => /自动恢复未能安排/.test(msg)),
        '排班被拒时应如实记录原因',
    );
    assert.equal(
        messages.some(msg => /已安排自动恢复/.test(msg)),
        false,
        '排班被拒时不应谎报已安排',
    );
});
