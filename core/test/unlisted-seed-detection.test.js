const test = require('node:test');
const assert = require('node:assert/strict');

const { isUnlistedSeedItem } = require('../src/config/gameConfig');

/**
 * 官方配置（Plant / ItemInfo）还没收录、但素材里有种子图的品种
 * （活动限定品种，例如 26038）必须能被认出是种子。
 *
 * 线上故障：这类种子按配置过滤时被当成「背包里没有种子」，
 * 于是白白去商店买种 —— 背包里明明躺着一把紫色品质的活动种子。
 */
test('配置未收录但素材里有种子图的品种被识别为种子', () => {
  // 26038 是活动限定品种：素材里有 seed_images_named/26038.png，
  // 但官方 Plant / ItemInfo 表都还没收录。
  assert.equal(isUnlistedSeedItem(26038), true);
});

test('已收录的种子不算未收录', () => {
  for (const id of [26030, 26032, 26127, 20001]) {
    assert.equal(isUnlistedSeedItem(id), false, `${id} 已收录，不应被判为未收录`);
  }
});

test('非种子区间的东西不会被误判成种子', () => {
  // 种子礼包（1016xx）和牧草（7001）都不是可直接种植的种子
  for (const id of [101620, 101621, 7001, 1007, 1, 0, -1]) {
    assert.equal(isUnlistedSeedItem(id), false, `${id} 不应被判为未收录种子`);
  }
});
