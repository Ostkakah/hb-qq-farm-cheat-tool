const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionStore } = require('../src/capture/session-store');

function createStore() {
  return createSessionStore({ config: {} });
}

test('会话的 WebSocket 帧能导出成 inspect-activity-har 读得的 HAR', () => {
  const store = createStore();
  const session = store.createSession('sess-1', 'qq');

  store.addWsFrame(session, 'send', Buffer.from('REQUEST-BYTES'));
  store.addWsFrame(session, 'receive', Buffer.from('RESPONSE-BYTES'));

  const har = store.exportSessionHar(session);
  const entries = har.log.entries;
  assert.equal(entries.length, 1);

  const messages = entries[0]._webSocketMessages;
  assert.ok(Array.isArray(messages), 'HAR 必须带 _webSocketMessages');
  assert.equal(messages.length, 2);

  assert.equal(messages[0].type, 'send');
  assert.equal(messages[0].opcode, 2);
  assert.equal(Buffer.from(messages[0].data, 'base64').toString(), 'REQUEST-BYTES');

  assert.equal(messages[1].type, 'receive');
  assert.equal(Buffer.from(messages[1].data, 'base64').toString(), 'RESPONSE-BYTES');
});

test('空会话导出也是合法 HAR', () => {
  const store = createStore();
  const session = store.createSession('sess-empty', 'wx');
  const har = store.exportSessionHar(session);
  assert.deepEqual(har.log.entries[0]._webSocketMessages, []);
});

test('帧数超过上限时丢弃最旧的，避免长时间抓包吃满内存', () => {
  const store = createStore();
  const session = store.createSession('sess-many', 'qq');
  for (let i = 0; i < 4100; i++) {
    store.addWsFrame(session, 'receive', Buffer.from(`frame-${i}`));
  }
  const messages = store.exportSessionHar(session).log.entries[0]._webSocketMessages;
  assert.equal(messages.length, 4000);
  // 丢的是最旧的，保留的是最近的
  assert.equal(Buffer.from(messages[messages.length - 1].data, 'base64').toString(), 'frame-4099');
});
