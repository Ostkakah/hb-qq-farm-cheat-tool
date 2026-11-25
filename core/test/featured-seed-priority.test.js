const test = require('node:test');
const assert = require('node:assert/strict');

const { isFeaturedSeedId, getFeaturedSeedName, isUnlistedSeedItem } = require('../src/config/gameConfig');
const { sortBagSeedsForPlanting } = require('../src/services/planting-service');

/**
 * 活动重点种子（蜜薯 20307）优先种植。
 *
 * 线上场景：以薯换福 活动发的蜜薯种子背包里躺着 26 个，
 * 但官方 Plant / ItemInfo 表都还没收录它，被当成「普通道具」过滤掉了，
 * 于是既不会被种，也不会显示名字。
 */

test('蜜薯 20307 被识别成活动重点种子，且官方配置未收录', () => {
  assert.equal(isFeaturedSeedId(20307), true);
  assert.equal(getFeaturedSeedName(20307), '蜜薯');
  // 本地官方配置确实没收录它 —— 这正是它以前被漏掉的原因
  assert.equal(isUnlistedSeedItem(20307), true);
});

test('普通种子不是活动重点种子', () => {
  for (const id of [20001, 20306, 26030, 26038]) {
    assert.equal(isFeaturedSeedId(id), false, `${id} 不应被当作活动重点种子`);
  }
});

test('背包里有蜜薯时优先种它（哪怕品质比别的低）', () => {
  const sorted = sortBagSeedsForPlanting([
    { seedId: 20001, rarity: 4, requiredLevel: 100, count: 1 }, // 黄品质
    { seedId: 20307, rarity: 2, requiredLevel: 0, count: 26 },  // 蜜薯
    { seedId: 26030, rarity: 3, requiredLevel: 50, count: 1 },
  ], []);

  assert.equal(sorted[0].seedId, 20307);
});

test('蜜薯也在用户自定义的优先清单之前', () => {
  const sorted = sortBagSeedsForPlanting([
    { seedId: 20001, rarity: 4, requiredLevel: 100, count: 1 },
    { seedId: 20307, rarity: 2, requiredLevel: 0, count: 26 },
  ], [20001]);

  assert.equal(sorted[0].seedId, 20307);
});

test('背包里没有蜜薯时按旧逻辑排（用户清单 → 品质 → 等级 → ID）', () => {
  const sorted = sortBagSeedsForPlanting([
    { seedId: 1001, rarity: 1, requiredLevel: 1, count: 1 },
    { seedId: 1002, rarity: 4, requiredLevel: 1, count: 1 },
    { seedId: 1003, rarity: 2, requiredLevel: 1, count: 1 },
    { seedId: 1004, rarity: 3, requiredLevel: 1, count: 1 },
  ], []);

  assert.deepEqual(sorted.map(s => s.seedId), [1002, 1004, 1003, 1001]);
});
