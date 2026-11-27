const assert = require('node:assert/strict');
const test = require('node:test');

/**
 * QQ 扫码登录换码链路。
 *
 * 腾讯 /ide/login 的响应里，顶层 code 是「接口状态码」（0 成功，负数为失败），
 * 真正的授权码通常在 data 里。旧实现直接把顶层 code 当授权码返回，
 * 上游返回 -3000 时会把错误码当登录 Code 入库，握手时被网关 400 拒绝。
 * 现在必须区分状态码与授权码，失败一律抛错、绝不返回错误码。
 */

const AXIOS_PATH = require.resolve('axios');
const QR_PATH = require.resolve('../src/services/qrlogin');

/** 用假的 axios 重新加载 qrlogin，跑完再还原模块缓存 */
async function withAxios(stub, fn) {
  const savedAxios = require.cache[AXIOS_PATH];
  const savedQr = require.cache[QR_PATH];
  require.cache[AXIOS_PATH] = { id: AXIOS_PATH, filename: AXIOS_PATH, loaded: true, exports: stub, children: [], paths: [] };
  delete require.cache[QR_PATH];
  try {
    return await fn(require('../src/services/qrlogin'));
  } finally {
    if (savedAxios) require.cache[AXIOS_PATH] = savedAxios; else delete require.cache[AXIOS_PATH];
    if (savedQr) require.cache[QR_PATH] = savedQr; else delete require.cache[QR_PATH];
  }
}

test('授权码识别：短数字/布尔/短串都不算授权码', () => {
  const { looksLikeAuthCode } = require('../src/services/qrlogin');
  assert.equal(looksLikeAuthCode('ABCDEFGHIJKLMNOP'), true);
  assert.equal(looksLikeAuthCode('1234567890123456'), true, '16 位以上的纯数字可以是授权码');
  assert.equal(looksLikeAuthCode('-3000'), false, '状态码不是授权码');
  assert.equal(looksLikeAuthCode('0'), false);
  assert.equal(looksLikeAuthCode('1234567'), false);
  assert.equal(looksLikeAuthCode('short'), false);
  assert.equal(looksLikeAuthCode(true), false);
  assert.equal(looksLikeAuthCode(undefined), false);
});

test('授权码提取：顶层 code 是状态码时要从 data 里取真实授权码', () => {
  const { findAuthCode } = require('../src/services/qrlogin');
  assert.equal(findAuthCode({ code: 0, data: { code: 'REAL_AUTH_CODE_1' } }), 'REAL_AUTH_CODE_1');
  assert.equal(findAuthCode({ code: 0, data: { authCode: 'REAL_AUTH_CODE_2' } }), 'REAL_AUTH_CODE_2');
  // 旧结构：顶层 code 本身就是长串授权码
  assert.equal(findAuthCode({ code: 'REAL_AUTH_CODE_3' }), 'REAL_AUTH_CODE_3');
  // 状态码不能被当成授权码
  assert.equal(findAuthCode({ code: -3000, message: '通道已停用' }), '');
  assert.equal(findAuthCode({ code: 0, data: {} }), '');
  assert.equal(findAuthCode({ code: 0, data: { ok: 1, uin: '12345' } }), '');
});

test('换码成功：返回真实授权码', async () => {
  await withAxios({
    post: async () => ({ status: 200, data: { code: 0, data: { code: 'AUTH_CODE_OK_123456' } } }),
    get: async () => ({ status: 200, data: {} }),
  }, async ({ MiniProgramLoginSession }) => {
    const code = await MiniProgramLoginSession.getAuthCode('ticket-1');
    assert.equal(code, 'AUTH_CODE_OK_123456');
  });
});

test('换码失败 -3000：抛错并提示该渠道已被腾讯停用（绝不返回错误码）', async () => {
  await withAxios({
    post: async () => ({ status: 200, data: { code: -3000, message: 'channel disabled' } }),
    get: async () => ({ status: 200, data: {} }),
  }, async ({ MiniProgramLoginSession }) => {
    await assert.rejects(() => MiniProgramLoginSession.getAuthCode('ticket-2'), (err) => {
      assert.match(err.message, /-3000/);
      assert.match(err.message, /停用/);
      return true;
    });
  });
});

test('换码失败：没返回授权码时抛错，而不是返回空串或状态码', async () => {
  await withAxios({
    post: async () => ({ status: 200, data: { code: 0, data: {} } }),
    get: async () => ({ status: 200, data: {} }),
  }, async ({ MiniProgramLoginSession }) => {
    await assert.rejects(() => MiniProgramLoginSession.getAuthCode('ticket-3'), /未返回有效授权码/);
  });
});

test('换码失败：接口异常与非 200 状态码都抛错', async () => {
  await withAxios({
    post: async () => { throw new Error('socket hang up'); },
    get: async () => ({ status: 200, data: {} }),
  }, async ({ MiniProgramLoginSession }) => {
    await assert.rejects(() => MiniProgramLoginSession.getAuthCode('ticket-4'), /腾讯换码接口请求失败/);
  });
  await withAxios({
    post: async () => ({ status: 500, data: {} }),
    get: async () => ({ status: 200, data: {} }),
  }, async ({ MiniProgramLoginSession }) => {
    await assert.rejects(() => MiniProgramLoginSession.getAuthCode('ticket-5'), /HTTP 500/);
  });
});

test('扫码检查接口：换码失败时返回 Error 且不给出 code，避免错误码入库', async () => {
  const { MiniProgramLoginSession } = require('../src/services/qrlogin');
  const originalQuery = MiniProgramLoginSession.queryStatus;
  const originalAuth = MiniProgramLoginSession.getAuthCode;
  MiniProgramLoginSession.queryStatus = async () => ({ status: 'OK', ticket: 't', uin: '12345', nickname: '昵称' });
  MiniProgramLoginSession.getAuthCode = async () => { throw new Error('腾讯换码失败 (code=-3000)'); };

  const routes = [];
  const app = { post: (path, handler) => routes.push({ path, handler }) };
  delete require.cache[require.resolve('../src/controllers/admin-qr-login-routes')];
  require('../src/controllers/admin-qr-login-routes').registerAdminQrLoginRoutes({ app });

  try {
    const check = routes.find(r => r.path === '/api/qr/check');
    assert.ok(check);
    const payload = {};
    const res = { json: (body) => { Object.assign(payload, body); }, status: () => ({ json: (body) => { Object.assign(payload, body); } }) };
    await check.handler({ body: { code: 'login-code' } }, res);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.status, 'Error');
    assert.match(payload.data.error, /QQ 授权码获取失败/);
    assert.equal(payload.data.code, undefined, '失败时绝不能带出 code 字段');
  } finally {
    MiniProgramLoginSession.queryStatus = originalQuery;
    MiniProgramLoginSession.getAuthCode = originalAuth;
  }
});
