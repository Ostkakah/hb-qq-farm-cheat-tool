const test = require('node:test');
const assert = require('node:assert/strict');

const { sortBagSeedsForPlanting } = require('../src/services/planting-service');

/**
 * 背包选种排序：品质优先（黄4 > 紫3 > 蓝2 > 普通1），
 * 品质相同再按所需等级降序。
 */
function seed(seedId, rarity, requiredLevel = 1) {
  return { seedId, rarity, requiredLevel, count: 1 };
}

test('背包选种按品质从高到低排（黄 > 紫 > 蓝 > 普通）', () => {
  const sorted = sortBagSeedsForPlanting([
    seed(1001, 1),  // 普通
    seed(1002, 4),  // 黄
    seed(1003, 2),  // 蓝
    seed(1004, 3),  // 紫
  ], []);

  assert.deepEqual(sorted.map(s => s.seedId), [1002, 1004, 1003, 1001]);
});

test('品质相同时按所需等级降序，等级也相同才按种子 ID 升序', () => {
  const sorted = sortBagSeedsForPlanting([
    seed(2001, 3, 10),
    seed(2002, 3, 50),
    seed(2003, 3, 50),
    seed(2004, 1, 99),
  ], []);

  assert.deepEqual(sorted.map(s => s.seedId), [2002, 2003, 2001, 2004]);
});

test('用户指定的优先清单仍然优先于品质', () => {
  const sorted = sortBagSeedsForPlanting([
    seed(3001, 4),
    seed(3002, 1),
  ], [3002]);

  assert.deepEqual(sorted.map(s => s.seedId), [3002, 3001]);
});

test('没有品质数据时退回等级排序，不报错', () => {
  const sorted = sortBagSeedsForPlanting([
    { seedId: 4001, requiredLevel: 10 },
    { seedId: 4002, requiredLevel: 60 },
  ], []);

  assert.deepEqual(sorted.map(s => s.seedId), [4002, 4001]);
});
