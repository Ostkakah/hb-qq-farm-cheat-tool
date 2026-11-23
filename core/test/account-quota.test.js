const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveAccountQuotaError } = require('../src/controllers/admin-account-routes');

const DEFAULT_LIMIT = 6;

test('普通用户未达额度时可以继续添加账号', () => {
  assert.equal(resolveAccountQuotaError({
    currentUser: { username: 'u1', role: 'user', accountLimit: 6 },
    accountCount: 2,
    defaultLimit: DEFAULT_LIMIT,
  }), null);
});

test('普通用户达到额度时被拦截', () => {
  const error = resolveAccountQuotaError({
    currentUser: { username: 'u1', role: 'user', accountLimit: 6 },
    accountCount: 6,
    defaultLimit: DEFAULT_LIMIT,
  });
  assert.match(error, /已达上限（6个）/);
});

test('accountLimit 为 -1 时不限数量', () => {
  assert.equal(resolveAccountQuotaError({
    currentUser: { username: 'u1', role: 'user', accountLimit: -1 },
    accountCount: 999,
    defaultLimit: DEFAULT_LIMIT,
  }), null);
});

test('未设置额度时回落到默认额度', () => {
  assert.equal(resolveAccountQuotaError({
    currentUser: { username: 'u1', role: 'user' },
    accountCount: 5,
    defaultLimit: DEFAULT_LIMIT,
  }), null);
  assert.match(resolveAccountQuotaError({
    currentUser: { username: 'u1', role: 'user' },
    accountCount: 6,
    defaultLimit: DEFAULT_LIMIT,
  }), /已达上限（6个）/);
});

test('管理员与超级管理员不受额度限制', () => {
  for (const role of ['admin', 'super_admin']) {
    assert.equal(resolveAccountQuotaError({
      currentUser: { username: 'a1', role, accountLimit: 2 },
      accountCount: 50,
      defaultLimit: DEFAULT_LIMIT,
    }), null);
  }
});

test('额度为 0 时表示一个都不能加', () => {
  assert.match(resolveAccountQuotaError({
    currentUser: { username: 'u1', role: 'user', accountLimit: 0 },
    accountCount: 0,
    defaultLimit: DEFAULT_LIMIT,
  }), /已达上限（0个）/);
});
