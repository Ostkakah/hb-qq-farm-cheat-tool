/**
 * 仓库服务 - 背包管理、果实出售、化肥使用
 *
 * 功能：
 * - 获取背包/背包详情
 * - 批量/单个出售作物果实
 * - 使用物品
 * - 自动使用化肥礼包
 * - 化肥容器时间计算
 */
const {
  getFruitName,
  getPlantByFruitId,
  getPlantBySeedId,
  getItemById,
  getItemImageById,
  getSeedLevel,
  getSeedImageBySeedId,
  isSeedItem,
  isUnlistedSeedItem,
  isFeaturedSeedId,
  getFeaturedSeedName,
} = require('../config/gameConfig');
const { isAutomationOn, getAutomation } = require('../models/store');
const { sendMsgAsync, networkEvents, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, sleep, getServerTimeSec } = require('../utils/utils');
const { FIREWORK_ITEM_ID, createFireworkUse } = require('./firework-use');
const { compareBagSeedGameOrder } = require('../utils/bag-seed-order');
const { updateStatusGold } = require('./status');

// ---- 常量 ----

// 批量出售大小
const SELL_BATCH_SIZE = 15;

// 自动出售时始终保留的物品：牧草是牧场动物口粮，不是拿来卖的
// 注意：牧草（7001）在植物表里对应植物 40，会被 isFruitItemId 判定为果实，必须显式排除
// 常量名与上游保持一致（上游仅判这一个 ID，本地扩展成集合以便后续追加）
const RANCH_GRASS_ITEM_ID = 7001;
const AUTO_SELL_RESERVED_ITEM_IDS = new Set([RANCH_GRASS_ITEM_ID]);

// 官方允许锁定的物品类型：17=果实/超变果实、6=果实、5=种子
// 注意：18=作物塔果实虽属植物果实，但官方不支持锁定/解锁。
const LOCKABLE_ITEM_TYPES = new Set([17, 6, 5]);
const NON_LOCKABLE_ITEM_TYPES = new Set([18]);
const MAX_LOCK_ITEM_UIDS = 200;

// 化肥容器上限（小时）
const FERTILIZER_CONTAINER_LIMIT_HOURS = 990;

// 容器物品 ID
const NORMAL_CONTAINER_ID = 1011;
const ORGANIC_CONTAINER_ID = 1012;

// 化肥相关物品 ID 集合
const FERTILIZER_RELATED_IDS = new Set([
  100003, 100004, 100005, 100006, 100007, 100008, 100009, 100010, 100011, 100012,
]);

// 普通化肥每小时提供时间（按物品 ID）
// 79873→1h, 80514→4h, 80003→8h, 80132→12h
const NORMAL_FERTILIZER_ITEM_HOURS = new Map([
  [79873, 1],
  [80514, 4],
  [80003, 8],
  [80132, 12],
]);

// 有机化肥每小时提供时间（按物品 ID）
// 80011→1h, 80012→4h, 80013→8h, 80014→12h
const ORGANIC_FERTILIZER_ITEM_HOURS = new Map([
  [80011, 1],
  [80012, 4],
  [80013, 8],
  [80014, 12],
]);

// ---- 状态追踪 ----

let fertilizerGiftDoneDateKey = '';
let fertilizerGiftLastOpenAt = 0;

// ---- 日期工具 ----

function getDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---- RPC 调用 ----

async function getBag() {
  const request = types.BagRequest.encode(types.BagRequest.create({})).finish();
  const { body } = await sendMsgAsync('gamepb.itempb.ItemService', 'Bag', request);
  return types.BagReply.decode(body);
}

function isItemLocked(item) {
  return item?.locked === true || item?.locked === 1 || item?.locked === '1';
}

function isLockableItem(item) {
  const id = toNum(item && item.id);
  const info = id > 0 ? getItemById(id) : null;
  return LOCKABLE_ITEM_TYPES.has(Number(info && info.type || 0));
}

function normalizeItemUids(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => toNum(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
}

async function setItemsLocked(itemUids, locked) {
  const requestedUids = normalizeItemUids(itemUids);
  if (requestedUids.length === 0) throw new Error('缺少物品 UID');
  if (requestedUids.length > MAX_LOCK_ITEM_UIDS) throw new Error(`一次最多操作 ${MAX_LOCK_ITEM_UIDS} 个物品`);

  const bagItems = getBagItems(await getBag());
  const byUid = new Map(
    bagItems
      .filter((item) => toNum(item && item.uid) > 0)
      .map((item) => [toNum(item.uid), item]),
  );
  const actionableUids = [];
  for (const uid of requestedUids) {
    const item = byUid.get(uid);
    if (!item) throw new Error(`背包中未找到 UID ${uid}`);
    const id = toNum(item.id);
    if (!isLockableItem(item)) throw new Error(`${getItemById(id)?.name || `物品${id}`}不支持锁定`);
    if (isItemLocked(item) !== Boolean(locked)) actionableUids.push(uid);
  }

  if (actionableUids.length === 0) return { locked: Boolean(locked), changed: 0, itemUids: [] };

  const RequestType = locked ? types.LockItemsRequest : types.UnlockItemsRequest;
  const ReplyType = locked ? types.LockItemsReply : types.UnlockItemsReply;
  const method = locked ? 'LockItems' : 'UnlockItems';
  const body = RequestType.encode(RequestType.create({
    item_uids: actionableUids.map((uid) => toLong(uid)),
  })).finish();
  const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', method, body);
  const reply = ReplyType.decode(replyBody);
  const confirmedUids = normalizeItemUids(reply && reply.item_uids);
  return {
    locked: Boolean(locked),
    changed: confirmedUids.length || actionableUids.length,
    itemUids: confirmedUids.length > 0 ? confirmedUids : actionableUids,
  };
}

function toSellItem(raw) {
  const id = toNum(raw && raw.id);
  const count = toNum(raw && raw.count);
  const uid = toNum(raw && raw.uid);
  const item = { id: toLong(id), count: toLong(count) };
  if (uid > 0) item.uid = toLong(uid);
  return item;
}

async function sellItems(items) {
  const requested = Array.isArray(items) ? items : [];
  if (requested.length === 0) throw new Error('没有可出售的物品');
  const bagItems = getBagItems(await getBag());
  for (const raw of requested) {
    const id = toNum(raw && raw.id);
    const count = toNum(raw && raw.count);
    const uid = toNum(raw && raw.uid);
    if (id <= 0 || count <= 0) throw new Error('出售物品参数无效');
    const info = getItemById(id);
    const name = info?.name || `物品${id}`;
    // 种子仅供种植，禁止出售，避免误操作清空背包种子。
    if (isSeedItem(id) || Number(info && info.type) === 5) throw new Error(`${name}是种子，不能出售`);
    if (uid > 0) {
      const matched = bagItems.find((entry) => toNum(entry && entry.uid) === uid);
      if (matched && isItemLocked(matched)) throw new Error(`${name}已锁定，不能出售`);
      continue;
    }
    // 未指定 UID 时按物品 ID 汇总：锁定部分不可出售
    let unlockedCount = 0;
    let lockedCount = 0;
    for (const entry of bagItems) {
      if (toNum(entry && entry.id) !== id) continue;
      if (isItemLocked(entry)) lockedCount += Math.max(0, toNum(entry && entry.count));
      else unlockedCount += Math.max(0, toNum(entry && entry.count));
    }
    if (count > unlockedCount) {
      const suffix = lockedCount > 0 ? `，其中 ${lockedCount} 个已锁定` : '';
      throw new Error(`${name}可售数量不足: 需要 ${count}，可售 ${unlockedCount}${suffix}`);
    }
  }

  const request = types.SellRequest.encode(
    types.SellRequest.create({ items: items.map(toSellItem) })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.itempb.ItemService', 'Sell', request);
  return types.SellReply.decode(body);
}

/**
 * 使用背包物品。官方请求要求携带物品 UID；未显式传入时从背包查找。
 */
async function useItem(itemId, count = 1, uid = 0) {
  if (toNum(itemId) === FIREWORK_ITEM_ID) return useFirework(count, uid);
  return useBagItem(itemId, count, uid);
}

const useFirework = createFireworkUse({
  now: getServerTimeSec,
  getFarm: async () => {
    const request = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
    const { body } = await sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', request);
    return types.AllLandsReply.decode(body);
  },
  place: uid => useBagItem(FIREWORK_ITEM_ID, 1, uid, {
    host_gid: toLong(getUserState().gid), use_config_id: 0,
  }),
  ignite: async () => {
    const request = types.FarmingRequest.encode(types.FarmingRequest.create({
      host_gid: toLong(getUserState().gid), host_type: 0, reason: 0,
      clear_farm_social_item_ids: [toLong(FIREWORK_ITEM_ID)],
    })).finish();
    const { body } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Farming', request);
    return types.FarmingReply.decode(body);
  },
});

async function useBagItem(itemId, count, uid, target) {
  let itemUid = toNum(uid);
  if (itemUid <= 0) {
    const bag = await getBag();
    const matching = getBagItems(bag).filter((item) =>
      toNum(item && item.id) === toNum(itemId) && toNum(item && item.count) > 0
    );
    const unlocked = matching.filter((item) => !isItemLocked(item));
    if (unlocked.length === 0 && matching.length > 0) {
      const lockedCount = matching.reduce((sum, item) => sum + Math.max(0, toNum(item && item.count)), 0);
      throw new Error(`物品已锁定，无法使用（${lockedCount} 个）`);
    }
    itemUid = toNum(unlocked[0] && unlocked[0].uid);
  }

  const request = types.UseRequest.encode(
    types.UseRequest.create({
      item: {
        id: toLong(itemId),
        count: toLong(count),
        uid: toLong(itemUid),
      },
      ...(target ? { target } : {}),
    })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', request);
  return types.UseReply.decode(body);
}

async function batchUseItems(entries) {
  const items = (entries || []).map((e) => ({
    id: toLong(e.itemId),
    count: toLong(e.count || 1),
    uid: toLong(e.uid || 0),
  }));

  const request = types.BatchUseRequest.encode(
    types.BatchUseRequest.create({ items })
  ).finish();

  const { body } = await sendMsgAsync('gamepb.itempb.ItemService', 'BatchUse', request);
  return types.BatchUseReply.decode(body);
}

// ---- 数据解析 ----

function isFruitItemId(id) {
  return !!getPlantByFruitId(Number(id));
}

/** 自动出售时必须保留的物品（如牧场口粮牧草） */
function isAutoSellReservedItemId(id) {
  return AUTO_SELL_RESERVED_ITEM_IDS.has(Number(id) || 0);
}

/**
 * 从背包回复中提取物品列表
 */
function getBagItems(reply) {
  if (reply && reply.item_bag && reply.item_bag.items && reply.item_bag.items.length) {
    return reply.item_bag.items;
  }
  return reply && reply.items ? reply.items : [];
}

/**
 * 判断是否为化肥相关物品
 */
function isFertilizerRelatedItemId(itemId) {
  const id = Number(itemId) || 0;
  if (id <= 0) return false;
  if (id === 1001 || id === 1002) return false;
  if (FERTILIZER_RELATED_IDS.has(id)) return true;

  const info = getItemById(id);
  if (!info || typeof info !== 'object') return false;
  const interactionType = String(info.interaction_type || '').toLowerCase();
  return interactionType === 'fertilizer' || interactionType === 'fertilizerpro';
}

/**
 * 从背包物品中收集化肥类物品的使用负载
 */
function collectFertilizerUsePayload(items) {
  const map = new Map();
  for (const item of items || []) {
    const id = toNum(item && item.id);
    const count = Math.max(0, toNum(item && item.count));
    if (id <= 0 || count <= 0) continue;
    if (!isFertilizerRelatedItemId(id)) continue;
    map.set(id, (map.get(id) || 0) + count);
  }
  return Array.from(map.entries()).map(([id, count]) => ({ id, count }));
}

/**
 * 从背包物品计算化肥容器剩余时间（小时）
 */
function getContainerHoursFromBagItems(items) {
  let normal = 0;
  let organic = 0;

  for (const item of items || []) {
    const id = toNum(item && item.id);
    const count = Math.max(0, toNum(item && item.count));
    if (id === NORMAL_CONTAINER_ID) normal = count;
    if (id === ORGANIC_CONTAINER_ID) organic = count;
  }

  // 容器值存储为秒，转换为小时
  return {
    normal: normal / 3600,
    organic: organic / 3600,
  };
}

/**
 * 获取化肥物品类型和每小时提供时间
 */
function getFertilizerItemTypeAndHours(itemId) {
  const id = Number(itemId) || 0;

  if (NORMAL_FERTILIZER_ITEM_HOURS.has(id)) {
    return { type: 'normal', perItemHours: NORMAL_FERTILIZER_ITEM_HOURS.get(id) };
  }
  if (ORGANIC_FERTILIZER_ITEM_HOURS.has(id)) {
    return { type: 'organic', perItemHours: ORGANIC_FERTILIZER_ITEM_HOURS.get(id) };
  }

  const info = getItemById(id) || {};
  const interactionType = String(info.interaction_type || '').toLowerCase();

  if (interactionType === 'fertilizer') return { type: 'normal', perItemHours: 1 };
  if (interactionType === 'fertilizerpro') return { type: 'organic', perItemHours: 1 };

  return { type: 'other', perItemHours: 0 };
}

/**
 * 判断是否为容器已满错误
 */
function isFertilizerContainerFullError(err) {
  const msg = String(err && err.message || '');
  return (
    msg.includes('code=1003002') ||
    msg.includes('普通化肥容器已达到上限') ||
    msg.includes('普通化肥容器已满') ||
    msg.includes('有机化肥容器已达到上限') ||
    msg.includes('有机化肥容器已满')
  );
}

// ---- 自动使用化肥 ----

async function autoOpenFertilizerGiftPacks() {
  try {
    const bag = await getBag();
    const items = getBagItems(bag);
    const payloads = collectFertilizerUsePayload(items);

    if (payloads.length <= 0) return 0;

    const containerHours = getContainerHoursFromBagItems(items);
    let totalUsed = 0;
    const usedLabels = [];

    for (const payload of payloads) {
      const itemId = Number(payload.id) || 0;
      let count = Math.max(0, Number(payload.count) || 0);
      const { type, perItemHours } = getFertilizerItemTypeAndHours(itemId);

      // 自适应调整使用量（不超过容器上限）
      if (type === 'normal' || type === 'organic') {
        const current = type === 'normal' ? containerHours.normal : containerHours.organic;
        if (current >= FERTILIZER_CONTAINER_LIMIT_HOURS) continue;

        if (perItemHours > 0) {
          const maxNeeded = Math.max(0, FERTILIZER_CONTAINER_LIMIT_HOURS - current);
          const maxByHours = Math.floor(maxNeeded / perItemHours);
          count = Math.max(0, Math.min(count, maxByHours));
          if (count <= 0) continue;
        }
      }

      const info = getItemById(itemId);
      const label = info && info.name ? String(info.name) : `物品#${itemId}`;

      let used = 0;
      try {
        await batchUseItems([{ itemId, count, uid: 0 }]);
        used = count;
      } catch (_) {
        used = 0;
      }

      if (used > 0) {
        totalUsed += used;
        usedLabels.push(`${label}x${used}`);

        if (type === 'normal' && perItemHours > 0) containerHours.normal += used * perItemHours;
        if (type === 'organic' && perItemHours > 0) containerHours.organic += used * perItemHours;
      }

      await sleep(100);
    }

    if (totalUsed > 0) {
      fertilizerGiftDoneDateKey = getDateKey();
      fertilizerGiftLastOpenAt = Date.now();
      log('仓库', `自动使用化肥类道具 x${totalUsed}${usedLabels.length ? ` [${usedLabels.join('，')}]` : ''}`, {
        module: 'warehouse', event: '开启化肥礼包', result: 'ok', count: totalUsed,
      });
    }

    return totalUsed;
  } catch (err) {
    if (isFertilizerContainerFullError(err)) return 0;
    logWarn('仓库', `开启化肥礼包失败: ${err.message}`, {
      module: 'warehouse', event: '开启化肥礼包', result: 'error',
    });
    return 0;
  }
}

async function openFertilizerGiftPacksSilently() {
  return autoOpenFertilizerGiftPacks();
}

// ---- 金币计算 ----

/**
 * 从物品列表获取金币数量（ID=1001）
 */
function getGoldFromItems(items) {
  for (const item of items || []) {
    const id = toNum(item.id);
    if (id === 1001 || id === 500001) {
      const count = toNum(item.count);
      if (count > 0) return count;
    }
  }
  return 0;
}

/**
 * 从出售回复推导金币变动
 */
function deriveGoldGainFromSellReply(reply, prevGold) {
  // 尝试 get_items 字段
  const getItemsGold = getGoldFromItems(reply && reply.get_items || []);
  if (getItemsGold > 0) {
    return { gain: getItemsGold, nextKnownGold: prevGold };
  }

  // 回退：items / sell_items
  const itemsGold = getGoldFromItems(reply && (reply.items || reply.sell_items) || []);
  if (itemsGold <= 0) return { gain: 0, nextKnownGold: prevGold };

  if (prevGold > 0 && itemsGold >= prevGold) {
    return { gain: itemsGold - prevGold, nextKnownGold: itemsGold };
  }

  return { gain: itemsGold, nextKnownGold: prevGold };
}

function getCurrentTotals() {
  const state = getUserState() || {};
  return {
    gold: Number(state.gold || 0),
    exp: Number(state.exp || 0),
  };
}

async function getCurrentTotalsFromBag() {
  const bag = await getBag();
  const items = getBagItems(bag);
  let gold = null;
  let exp = null;
  for (const item of items) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    if (id === 1001 || id === 500001) gold = count;
    if (id === 1002 || id === 500002) exp = count;
  }
  return { gold, exp };
}

// ---- 背包详情 ----

async function getBagDetail() {
  const bag = await getBag();
  const items = getBagItems(bag);

  // 原始物品列表
  const originalItems = [];
  for (const item of items || []) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    const uid = toNum(item.uid);
    if (id <= 0 || count <= 0) continue;
    originalItems.push({ id, count, uid, locked: isItemLocked(item) });
  }

  // 按 ID 去重合并
  const merged = new Map();
  for (const item of items || []) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    if (id <= 0 || count <= 0) continue;

    const info = getItemById(id) || null;
    const seedPlant = getPlantBySeedId(id);
    let name = info && info.name ? String(info.name) : '';
    let category = 'item';

    if (id === 1001 || id === 500001) { name = '金币'; category = 'gold'; }
    else if (id === 1002 || id === 500002) { name = '经验'; category = 'exp'; }
    else if (getPlantByFruitId(id)) {
      if (!name) name = `${getFruitName(id)  }果实`;
      category = 'fruit';
    } else if (seedPlant) {
      if (!name) name = `${seedPlant.name || '未知'  }种子`;
      category = 'seed';
    }

    if (!name) name = `物品${  id}`;

    const interactionType = info && info.interaction_type ? String(info.interaction_type) : '';
    const priceId = info ? Number(info.price_id) || 0 : 0;
    const directSell = String(info && info.sells || '').match(/^(\d+):(\d+)$/);
    const effectivePriceId = directSell ? Number(directSell[1]) : priceId;
    const effectivePrice = directSell ? Number(directSell[2]) : (info ? Number(info.price) || 0 : 0);
    const priceUnit =
      effectivePriceId === 1005 ? '金豆豆' :
      effectivePriceId === 200 ? '点券' : '金';

    if (!merged.has(id)) {
      merged.set(id, {
        id,
        count: 0,
        name,
        image: getItemImageById(id),
        category,
        itemType: info ? Number(info.type) || 0 : 0,
        priceId: effectivePriceId,
        price: effectivePrice,
        priceUnit,
        sellable: !(Number(info && info.type) === 5 || isSeedItem(id))
          && Boolean(directSell || getPlantByFruitId(id)),
        usable: Number(info && info.can_use) === 1 || interactionType === 'use',
        level: info ? Number(info.level) || 0 : 0,
        rarity: seedPlant ? Math.max(
          seedPlant.special_fruit ? 3 : 0,
          Number(info && info.rarity) || 0
        ) : 0,
        plantExp: seedPlant ? Math.max(0, Number(seedPlant.exp) || 0) : 0,
        plantingPriority: seedPlant ? Math.max(0, Number(seedPlant.planting_priority) || 0) : 0,
        plantSize: seedPlant ? Math.max(1, Number(seedPlant.size || 1)) : 1,
        interactionType,
        hoursText: '',
        lockedCount: 0,
        unlockedCount: 0,
      });
    }
    const entry = merged.get(id);
    entry.count += count;
    if (isItemLocked(item)) entry.lockedCount += count;
    else entry.unlockedCount += count;
  }

  // 计算容器时间显示
  const resultItems = Array.from(merged.values()).map((entry) => {
    if (entry.interactionType === 'fertilizerbucket' && entry.count > 0) {
      const hours = Math.floor(entry.count / 3600 * 10) / 10;
      entry.hoursText = `${hours.toFixed(1)  }小时`;
    }
    entry.lockable = !NON_LOCKABLE_ITEM_TYPES.has(Number(entry.itemType || 0))
      && (LOCKABLE_ITEM_TYPES.has(Number(entry.itemType || 0))
        || Boolean(getPlantByFruitId(entry.id)));
    entry.locked = entry.lockable && entry.lockedCount > 0 && entry.unlockedCount === 0;
    entry.partiallyLocked = entry.lockable && entry.lockedCount > 0 && entry.unlockedCount > 0;
    return entry;
  });

  // 排序：按物品类型排序，同类型按数量降序
  const typeOrder = new Map([[1, 1], [2, 2], [4, 3]]);
  resultItems.sort((a, b) => {
    if (a.category === 'seed' && b.category === 'seed')
      return compareBagSeedGameOrder(a, b);

    const typeA = Number(a.itemType || 0);
    const typeB = Number(b.itemType || 0);
    const orderA = typeOrder.has(typeA) ? typeOrder.get(typeA) : (typeA > 0 ? 1000 + typeA : Number.MAX_SAFE_INTEGER);
    const orderB = typeOrder.has(typeB) ? typeOrder.get(typeB) : (typeB > 0 ? 1000 + typeB : Number.MAX_SAFE_INTEGER);
    if (orderA !== orderB) return orderA - orderB;
    const countB = Number(b.count || 0);
    const countA = Number(a.count || 0);
    if (countB !== countA) return countB - countA;
    return Number(a.id || 0) - Number(b.id || 0);
  });

  return {
    totalKinds: resultItems.length,
    items: resultItems,
    originalItems,
  };
}

// ---- 出售果实 ----

/**
 * 出售所有果实
 */
async function sellAllFruits() {
  const sellEnabled = isAutomationOn('sell');
  if (!sellEnabled) return;

  try {
    const bag = await getBag();
    const items = getBagItems(bag);
    const fruits = [];
    const automationSnapshot = getAutomation();

    for (const item of items) {
      const id = toNum(item.id);
      const count = toNum(item.count);
      // 牧场口粮等保留物品不参与自动出售
      if (isAutoSellReservedItemId(id)) continue;
      // 活动插件可注册果实保留谓词（如奶茶营业期保护活动果实不被自动卖）
      const reservedByPlugin = require('../plugins/worker-host-bridge').reserveFruit(id, {
        automation: automationSnapshot,
        nowSec: getServerTimeSec(),
      });
      if (isFruitItemId(id) && count > 0 && !reservedByPlugin && !isItemLocked(item)) {
        fruits.push(item);
      }
    }

    if (fruits.length === 0) {
      log('仓库', '无果实可出售');
      return;
    }

    const totalsBefore = getCurrentTotals();
    const prevGold = totalsBefore.gold;
    let totalGoldFromReply = 0;
    let derivedGold = prevGold;
    const soldLabels = [];
    let soldKindCount = 0;
    let soldTotalCount = 0;
    let skippedKindCount = 0;

    function recordSoldFruit(item) {
      const id = toNum(item.id);
      const count = toNum(item.count);
      soldLabels.push(`${getFruitName(id)  }x${  count}`);
      soldKindCount += 1;
      soldTotalCount += count;
    }

    // 批量出售
    for (let i = 0; i < fruits.length; i += SELL_BATCH_SIZE) {
      const batch = fruits.slice(i, i + SELL_BATCH_SIZE);
      try {
        const sellResult = await sellItems(batch);
        const derived = deriveGoldGainFromSellReply(sellResult, derivedGold);
        const gain = Math.max(0, toNum(derived.gain));
        derivedGold = derived.nextKnownGold;
        if (gain > 0) totalGoldFromReply += gain;
        batch.forEach(recordSoldFruit);
      } catch (err) {
        // 批量失败，逐个重试
        logWarn('仓库', `批量出售失败，改为逐个重试: ${err.message}`);
        for (const fruit of batch) {
          try {
            const result = await sellItems([fruit]);
            const derived = deriveGoldGainFromSellReply(result, derivedGold);
            const gain = Math.max(0, toNum(derived.gain));
            derivedGold = derived.nextKnownGold;
            if (gain > 0) totalGoldFromReply += gain;
            recordSoldFruit(fruit);
          } catch (innerErr) {
            const fid = toNum(fruit.id);
            const fcount = toNum(fruit.count);
            skippedKindCount += 1;
            logWarn('仓库', `跳过不可售物品: ID=${fid} x${fcount} (${innerErr.message})`, {
              module: 'warehouse', event: '跳过不可售物品', result: 'skip', itemId: fid, count: fcount,
            });
          }
        }
      }
      if (i + SELL_BATCH_SIZE < fruits.length) await sleep(300);
    }

    // 等待金币更新
    let finalGold = prevGold;
    const startWait = Date.now();
    while (Date.now() - startWait < 3000) {
      const state = getUserState();
      const stateGold = state && state.gold ? state.gold : finalGold;
      if (stateGold !== prevGold) { finalGold = stateGold; break; }
      await sleep(200);
    }

    const totalsAfter = getCurrentTotals();
    const goldByState = finalGold > prevGold ? finalGold - prevGold : 0;
    const goldDelta = totalsAfter.gold - totalsBefore.gold;
    const expDelta = totalsAfter.exp - totalsBefore.exp;

    // 金币结算：优先用状态差值，回退到出售响应
    let bagGoldGain = 0;
    if (goldByState <= 0 && totalGoldFromReply <= 0) {
      try {
        const bagAfter = await getBag();
        const bagGold = getGoldFromItems(getBagItems(bagAfter));
        if (bagGold > prevGold) bagGoldGain = bagGold - prevGold;
      } catch (_) {}
    }

    const totalGoldGain = Math.max(totalGoldFromReply, goldByState, bagGoldGain);

    // 若状态未更新但出售有响应，手动修正状态
    if (goldByState <= 0 && totalGoldGain > 0) {
      const state = getUserState();
      if (state) {
        state.gold = Number(state.gold || 0) + totalGoldGain;
        updateStatusGold(state.gold);
      }
    }

    if (soldLabels.length === 0) {
      logWarn('仓库', `本轮果实出售未成功${skippedKindCount > 0 ? `，已跳过 ${skippedKindCount} 个不可售物品` : ''}`, {
        module: 'warehouse',
        event: 'sell_done',
        result: 'skipped',
        count: 0,
        skippedCount: skippedKindCount,
        totalsBefore,
        totalsAfter,
        totalsDeltaGold: goldDelta,
        totalsDeltaExp: expDelta,
      });
      return;
    }

    log('仓库', `出售 ${soldLabels.join(', ')}${skippedKindCount > 0 ? `，跳过 ${skippedKindCount} 个不可售物品` : ''}${totalGoldGain > 0 ? `，获得 ${totalGoldGain} 金币` : ''}`, {
      module: 'warehouse',
      event: totalGoldGain > 0 ? 'sell_success' : 'sell_done',
      result: totalGoldGain > 0 ? 'ok' : 'unknown_gain',
      count: soldKindCount,
      soldCount: soldTotalCount,
      skippedCount: skippedKindCount,
      gold: totalGoldGain,
      totalsBefore,
      totalsAfter,
      totalsDeltaGold: goldDelta,
      totalsDeltaExp: expDelta,
    });

    if (totalGoldGain > 0) {
      networkEvents.emit('sell', { gold: totalGoldGain, count: soldTotalCount });
    }
  } catch (err) {
    logWarn('仓库', `出售失败: ${err.message}`);
  }
}

// ---- 种子列表 ----

/**
 * 获取背包中的种子列表
 */
async function getBagSeeds() {
  const bag = await getBag();
  const items = getBagItems(bag);
  const seedMap = new Map();
  const fallbackSeedIds = [];
  const unlistedSeedIds = new Set();

  for (const item of items || []) {
    const id = toNum(item && item.id);
    const count = toNum(item && item.count);
    if (id <= 0 || count <= 0) continue;

    if (isItemLocked(item)) continue; // 已锁定种子不参与自动种植选种
    const plant = getPlantBySeedId(id);
    const info = getItemById(id) || null;
    const interactionType = String(info && info.interaction_type || '').toLowerCase();
    // 官方配置未收录但素材里有图的活动种子也要认出来，
    // 否则会被当成「背包里没有种子」→ 白白去商店买种。
    const unlistedSeed = !plant && !info && isUnlistedSeedItem(id);
    const seedLike = !!plant || isSeedItem(id) || interactionType === 'plant' || unlistedSeed;
    if (!seedLike) continue;
    if (unlistedSeed) {
      unlistedSeedIds.add(id);
    }

    if (!plant && fallbackSeedIds.length < 20) fallbackSeedIds.push(id);

    const rawName = plant && plant.name ? String(plant.name) : String(info && info.name || `??#${id}`);
    const name = rawName.endsWith('??') ? rawName.slice(0, -2) : rawName;
    const requiredLevel = Math.max(0, Number(
      getSeedLevel(id) || (info && info.level) || (plant && plant.land_level_need) || 0
    ));
    const plantSize = plant ? Math.max(1, Number(plant.size || 1)) : 1;

    const existing = seedMap.get(id) || {
      seedId: id,
      name: unlistedSeed ? (getFeaturedSeedName(id) || `种子${id}`) : name,
      count: 0,
      requiredLevel,
      // 未收录种子的品质无从得知，按活动植物的下限（蓝）保守处理，
      // 不让它跟已知的高品质种子抢优先级；等级限制同样按「不限制」处理。
      // 例外：活动重点种子（蜜薯）单独标记最高品质，保证它一路排到最前。
      rarity: unlistedSeed
        ? (isFeaturedSeedId(id) ? 4 : 2)
        : Math.max(
            plant && plant.special_fruit ? 3 : 0,
            Number(info && info.rarity) || 0
        ),
      plantExp: Math.max(0, Number(plant && plant.exp) || 0),
      plantingPriority: Math.max(0, Number(plant && plant.planting_priority) || 0),
      image: getSeedImageBySeedId(id) || getItemImageById(id),
      plantSize,
    };
    existing.count += count;
    seedMap.set(id, existing);
  }

  if (fallbackSeedIds.length > 0) {
    log('warehouse', `bag seed fallback detection: ${fallbackSeedIds.join(',')}`, {
      module: 'warehouse', event: 'bag_seed_detect', result: 'fallback', count: fallbackSeedIds.length,
    });
  }

  if (unlistedSeedIds.size > 0) {
    // 这些种子的官方配置（Plant / ItemInfo）还没同步到，只能按「未知品质」参与选种。
    // 提示维护者去跑 sync-official-configs.js 补齐。
    log('warehouse', `背包里有 ${unlistedSeedIds.size} 种官方配置未收录的种子（${[...unlistedSeedIds].join(',')}），已按种子参与选种；建议执行 sync-official-configs.js 补齐官方配置`, {
      module: 'warehouse', event: 'bag_seed_detect', result: 'unlisted', count: unlistedSeedIds.size,
      seedIds: [...unlistedSeedIds],
    });
  }

  return Array.from(seedMap.values());
}

// ---- ?? ----
module.exports = {
  getBag,
  getBagDetail,
  setItemsLocked,
  sellItems,
  useItem,
  batchUseItems,
  openFertilizerGiftPacksSilently,
  getFertilizerGiftDailyState: () => ({
    key: 'fertilizer_gift_open',
    doneToday: fertilizerGiftDoneDateKey === getDateKey(),
    lastOpenAt: fertilizerGiftLastOpenAt,
  }),
  sellAllFruits,
  isAutoSellReservedItemId,
  getBagItems,
  getCurrentTotalsFromBag,
  getBagSeeds,
  getContainerHoursFromBagItems,
};
