const { ranchOperationDetails, ranchOperationModule } = require('./ranch-operation-log');
const { ranchLevel, upgradeBlockReason } = require('./ranch-upgrade');
const { createRanchProtocol, ANIMAL_STAGE_LABELS } = require('./ranch-protocol');
const { ranchSession } = require('./ranch-session');
const config = require('../gameConfig/RanchConfig.json');
const { getAnimalVisual, getFacilityVisual } = require('./ranch-visuals');
const { getItemImageById } = require('../config/gameConfig');
const shopConfig = require('../gameConfig/RanchShopConfig.json');
const goodsMap = new Map(shopConfig.MCGoods.map(row => [String(row.id), row]));
const CAPABILITIES = Object.freeze({ connect: false, disconnect: false, claimTask: true, collect: true, clean: true, place: true, produce: true, harvest: true, addFeed: true, submitOrder: true, refreshOrder: true, claimIllustrated: true, claimWeight: true, claimShare: true, claimFreeGift: true, buy: true, exchange: true, friendActions: true, sell: true, useCan: true, visitors: true, feedAnimal: true, activateFacility: true, upgradeBuilding: true, completeUpgrade: true, buildingEdit: false, landUnlock: false });
const { SETTINGS_KEYS, ACTION_SWITCH, ALWAYS_ON, normalizePolicy, normalizeSettings } = require('./ranch-settings');
const { feedTypes, quietNow, createRanchMaturityPlan, giantCubInfo } = require('./ranch-strategy');
const { createRanchScheduler, inGroup } = require('./ranch-scheduler');
const { runRanchExtraAutomation, assertAutomationPolicy } = require('./ranch-automation');
const itemMap = new Map(config.MCItemInfo.map(row => [String(row.id), row]));
const animalIcons = require('../gameConfig/RanchAnimalIcons.json');
const ranchItemImage = id => animalIcons[String(id)]?.[1] || (String(id) === '7002' ? '/game-config/ranch-icons/poop.png' : getItemImageById(id));
const SHOP_RESOURCE_IDS = [1007, 1008, 1002, 1004, 7002];
// 好友牧草机用金券补满：抓包实测 60 金券（1007）/ 单位，回包 detail.feed_count 直接到 capacity。
const GOLD_ITEM_ID = '1007';
const FEED_GOLD_UNIT_COST = 60n;
// 自动化写请求节流：新号第一次进牧场时，补草/装填罐头/放幼崽/照料好友会一次性排满，
// 实测 4 秒内能打出十几条写请求（局部峰值 10~15 条/秒），远超玩家手动点击的节奏。
// 服务端对这种突发没有宽容度：会话会被直接丢掉（无 close 帧，只能等入站静默超时才发现）。
// 这里把自动化写请求按人手点击的节奏排队：每条间隔在 950~1250ms 之间随机取值，
// 正好让"新号首轮 17 条动作"落在 15~20 秒（16 个间隙）。不用固定间隔——规整的等距
// 波形本身就是机器特征。手动操作不排队。
const GAP_ENV = process.env.RANCH_ACTION_GAP_MS;
const AUTOMATION_GAP_MIN_MS = Math.max(0, Number(GAP_ENV ?? process.env.RANCH_ACTION_GAP_MIN_MS ?? 950) || 0);
const AUTOMATION_GAP_MAX_MS = Math.max(AUTOMATION_GAP_MIN_MS, Number(GAP_ENV ?? process.env.RANCH_ACTION_GAP_MAX_MS ?? 1250) || 0);
function nextActionGapMs() {
    if (!(AUTOMATION_GAP_MAX_MS > 0)) return 0;
    if (AUTOMATION_GAP_MAX_MS === AUTOMATION_GAP_MIN_MS) return AUTOMATION_GAP_MIN_MS;
    return AUTOMATION_GAP_MIN_MS + Math.random() * (AUTOMATION_GAP_MAX_MS - AUTOMATION_GAP_MIN_MS);
}
let automationActionSlot = 0;
async function paceAutomationWrite() {
    const gap = nextActionGapMs();
    if (!(gap > 0)) return;
    const now = Date.now();
    const slot = Math.max(now, automationActionSlot);
    automationActionSlot = slot + gap;
    if (slot > now) await new Promise(resolve => setTimeout(resolve, slot - now));
}
const ANIMAL_PHASE_DURATION_FIELDS = Object.freeze({ 1: 'infant_sec', 2: 'grow_sec', 3: 'product_round_sec', 4: 'mature_sec' });
const animalMap = new Map(config.MCAnimalConfig.map(row => [String(row.id), row]));
const facilityMap = new Map(config.MCFacilityConfig.map(row => [String(row.facility_id), row]));
// 巨大化重量档位（匀称/超重/极重/巨无霸）：图鉴条目的巨大化个体按 tier 显示档位名
const weightTierMap = new Map(require('../gameConfig/ranch/MCRanchWeightTier.json').map(row => [Number(row.tier), row]));
// 图鉴收录顺序（官方等级排序）：fruit_id -> sort，与官方界面/幼崽商店一致
const illustratedSortMap = new Map(require('../gameConfig/Illustrated.json').map(row => [Number(row.param), Number(row.sort)]));
const illustratedSortKey = fruitId => illustratedSortMap.get(Number(fruitId)) ?? Number(fruitId);
const ACTION_NAMES = Object.freeze({ claimTask: '领取牧场任务奖励', visitFriend: '查看好友牧场', steal: '偷取好友产物', friendProduce: '帮好友生产', help: '帮助清理', stroke: '照料好友动物', putHazard: '放蚊子', friendFeed: '给好友加牧草', sell: '出售牧场产物', useCan: '装填罐头', collect: '收集产物', clean: '清理灾害', place: '放入幼崽', produce: '开始生产', harvest: '收获动物', addFeed: '补充牧草', submitOrder: '提交订单', refreshOrder: '刷新订单', claimIllustrated: '图鉴领奖', claimWeight: '重量积分领奖', claimDailyShare: '领取每日分享礼包', claimFreeGift: '领取免费礼包', buy: '购买商品', exchange: '兑换商品', feedAnimal: '使用罐头容器', activateFacility: '解锁棚', upgradeBuilding: '升级设施', completeUpgrade: '完成设施升级' });
const camel = key => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function camelize(value) {
    if (Array.isArray(value)) return value.map(camelize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [camel(key), camelize(v)]));
}
function describeResource(raw) {
    const value = camelize(raw);
    function visit(node) {
        if (Array.isArray(node)) return node.map(visit);
        if (!node || typeof node !== 'object') return node;
        const result = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v)]));
        const id = result.itemId ?? result.fruitId ?? (result.count != null ? result.id : undefined);
        if (id != null) { result.name = itemMap.get(String(id))?.name || animalMap.get(String(id))?.name || `物品 ${id}`; result.image = ranchItemImage(id); }
        if (result.costItemId != null) result.costItemName = itemMap.get(String(result.costItemId))?.name || `物品 ${result.costItemId}`;
        return result;
    }
    return visit(value);
}
function normalizeItem(raw) {
    const item = camelize(raw);
    const row = itemMap.get(String(item.id));
    const ids = row?.show_tab_ids;
    return { ...item, image: getItemImageById(item.id), locked: item.isLocked === true || item.locked === true, detail: item.itemDetail || item.detail, name: row?.name || `物品 ${item.id}`, type: row?.type ?? null,
        canUseCan: !item.isLocked && !item.locked && config.MCCanConfig.some(c => String(c.id) === String(item.id)),
        canSell: !item.isLocked && !item.locked && [106, 107].includes(row?.type),
        tabIds: ids == null ? [] : Array.isArray(ids) ? ids.map(Number) : String(ids).split(/[;,]/).map(Number).filter(Number.isFinite) };
}
function normalizeSnapshot({ cells, ranches, bag, tabs, order, orderError, serverTime, settings, farmLevel }) {
    const facilities = (cells.facilities || []).map(raw => {
        const value = camelize(raw); const row = facilityMap.get(String(raw.facility_id));
        const next = facilityMap.get(String(row?.next_facility_id));
        const nextUpgradeCost = String(next?.upgrade_cost || '').split(';').filter(Boolean).map(v => { const [id, count] = v.split(':'); return { id, count, name: itemMap.get(id)?.name || `物品 ${id}` }; });
        return { ...value, visual: getFacilityVisual(row), facilityKind: row?.module_type, instId: value.instanceId, name: row?.name || `设施 ${value.facilityId}`, nextLevel: next?.level, nextUpgradeCost, nextUpgradeSeconds: next?.upgrade_secs, nextUpgradeConditions: next?.upgrade_conditions };
    });
    const items = [...(bag.physical_items || []), ...(bag.virtual_items || [])].map(normalizeItem);
    const unlockedCount = id => items.filter(i => String(i.id) === String(id) && !i.locked && !i.detail?.ranchProduct).reduce((total, i) => total + BigInt(i.count || 0), 0n);
    const normalizedRanches = ranches.map(raw => {
        const value = camelize(raw);
        const facility = facilities.find(f => String(f.ranch?.ranchInstId) === String(value.ranchInstId));
        // 可放入的幼崽：普通幼崽 + 官方巨大化幼崽（背包里有就报出来，自动化据此优先放巨大幼崽）
        const ranchCubs = config.MCAnimalConfig
            .filter(a => a.enable_flag === true && (value.husbandryType === 1 ? a.husbandry_type === '窝' : value.husbandryType === 2 ? a.husbandry_type === '棚' : false))
            .flatMap(a => {
                const normal = { itemId: String(a.cub_item_id), animalId: String(a.id), name: a.name, count: String(unlockedCount(a.cub_item_id)) };
                const giant = giantCubInfo(Number(a.cub_item_id) + 5000);
                if (!giant) return [normal];
                return [normal, {
                    itemId: giant.itemId,
                    animalId: giant.animalId,
                    baseItemId: giant.baseItemId,
                    name: giant.name,
                    giant: true,
                    level: giant.level,
                    count: String(unlockedCount(giant.itemId)),
                }];
            });
        return { ...value, availableCubs: ranchCubs, name: facility?.name || `窝棚 ${value.ranchInstId}`,
            animals: (value.animals || []).map(a => ({ ...a, image: animalIcons[String(a.animalId)]?.[a.stage === 1 ? 1 : 4] || '', phaseDurationMs: Number(animalMap.get(String(a.animalId))?.[ANIMAL_PHASE_DURATION_FIELDS[a.stage]] || 0) * 1000, visual: getAnimalVisual(a.animalId, a.stage, a.mutation), stageLabel: ANIMAL_STAGE_LABELS[a.stage] || '未知', canTriggerProduce: a.stage === 3 && !a.producing && a.canDeliver === true, name: animalMap.get(String(a.animalId))?.name || `动物 ${a.animalId}` })),
            shelves: (value.shelves || []).map(s => ({ ...s, lots: (s.lots || []).map(lot => ({ ...lot, name: itemMap.get(String(lot.itemId))?.name || `物品 ${lot.itemId}` })) })),
        };
    });
    const upgradeState = { items, ranchLevel: ranchLevel(items) };
    for (const facility of facilities) facility.upgradeBlockedReason = upgradeBlockReason(facility, upgradeState, farmLevel);
    return {
        ranchLevel: upgradeState.ranchLevel,
        // 单账号只有一条连接，农场/牧场是互斥场景（同一时刻只驻留一个），不存在并行会话。
        sceneReady: true, sessionState: 'exclusive', serverTime, syncedAt: Date.now(), settings, capabilities: CAPABILITIES,
        grid: { width: cells.grid_width, height: cells.grid_height }, ranches: normalizedRanches,
        facilities, buildingItems: (cells.building_items || []).map(raw => ({ ...camelize(raw), name: facilityMap.get(String(raw.facility_id))?.name || `建筑 ${raw.facility_id}` })),
        items, tabs: (tabs.tabs || []).map(tab => ({ id: tab.tab_id, name: tab.tab_name, count: tab.item_count })),
        currencies: [1007, 1008].map(id => ({ id, name: itemMap.get(String(id))?.name, count: items.find(i => String(i.id) === String(id))?.count ?? '0' })),
        orders: (order?.panel?.slots || []).map(slot => ({ ...camelize(slot), id: slot.instance_id, name: `订单 ${slot.slot_index + 1}`, canSubmit: !!slot.instance_id && slot.submit_state === 1 && Number(order.panel.submit_quota) > 0, canRefresh: !!slot.instance_id && Number(order.panel.refresh_quota) > 0, statusLabel: slot.submit_state === 1 ? '材料已备齐，可提交' : slot.submit_state === 2 ? '材料不足' : '暂不可提交', requirements: (slot.req_items || []).map(normalizeItem), rewards: (slot.reward_items || []).map(normalizeItem) })),
        orderPanel: order?.panel ? camelize(order.panel) : null, ordersError: orderError || null,
    };
}
function createRanchService({ rpc, session = ranchSession, getUserState, getSettings = () => ({}), log = () => {}, now = Date.now, serverNow = now, getKnownFriendGids = () => require('../models/store').getKnownFriendGids(), friendRosterDir = null, statsAccountId = () => process.env.FARM_ACCOUNT_ID || '', operationsSaveDebounceMs = 2000 } = {}) {
    const scheduler = createRanchScheduler({ now });
    let operation = 0;
    let automationRunning = false;
    const continuations = new Map();
    const friendCursors = { all: 0, farm: 0, help: 0, steal: 0 };
    const maturityPlan = createRanchMaturityPlan(now);
    let planEpoch;
    const settings = () => ({ ...ALWAYS_ON, ...normalizeSettings(getSettings()) });
    const scheduledSettings = () => {
        const result = settings();
        // 常驻每日礼包不进自动化队列：它们由心跳单独驱动，不该让牧场自动化保持常开。
        for (const key of Object.keys(ALWAYS_ON)) delete result[key];
        if (quietNow(normalizePolicy(getSettings().ranch_policy), now())) {
            for (const key of ['autoHelp', 'autoStroke', 'autoPutHazard', 'autoSteal', 'autoFriendFeed']) result[key] = false;
        }
        return result;
    };
    const operations = {};
    const dayKey = () => new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
    let operationsDate = dayKey();
    // 今日操作计数持久化：data/stats/ranch-<账号id>.json（date 校验，隔日过期清零）。
    // 牧场此前只存内存，进程重启当天计数就丢——账号9「偷产物统计为 0」的根因之一。
    const { loadRanchStats, saveRanchStats } = require('./ranch-stats');
    let operationsSaveTimer = null;
    function scheduleOperationsSave() {
        if (operationsSaveTimer) return;
        operationsSaveTimer = setTimeout(() => {
            operationsSaveTimer = null;
            saveRanchStats(statsAccountId(), { date: dayKey(), operations: { ...operations }, savedAt: Date.now() });
        }, operationsSaveDebounceMs);
    }
    function flushOperationsSave() {
        if (operationsSaveTimer) { clearTimeout(operationsSaveTimer); operationsSaveTimer = null; }
        saveRanchStats(statsAccountId(), { date: dayKey(), operations: { ...operations }, savedAt: Date.now() });
    }
    (function restoreOperations() {
        const persisted = loadRanchStats(statsAccountId());
        if (persisted && persisted.date === dayKey()) {
            for (const [key, value] of Object.entries(persisted.operations || {})) operations[key] = Number(value) || 0;
        }
    })();
    function syncOperationsDay() {
        if (operationsDate !== dayKey()) {
            for (const key of Object.keys(operations)) delete operations[key];
            operationsDate = dayKey();
            scheduleOperationsSave();
        }
    }
    let lastAutomationAt = null;
    // 每日分享与免费礼包：同一天成功（或明确已领取）后不再重试，失败按 10 分钟退避。
    const DAILY_SHARE = Object.freeze({ id: '102', docId: '2102' });
    const DAILY_RETRY_MS = 10 * 60 * 1000;
    const dailyRoutines = { share: { dateKey: '', done: false, lastAt: 0, failures: 0 }, gift: { dateKey: '', done: false, lastAt: 0, failures: 0 } };
    function dailyRoutine(name) {
        const slot = dailyRoutines[name];
        const today = dayKey();
        if (slot.dateKey !== today) Object.assign(slot, { dateKey: today, done: false, lastAt: 0, failures: 0 });
        return slot;
    }
    // 免费礼包判定：官方 is_free 且零价，未拥有、非广告位、未售罄。
    function isFreeMallGood(good) {
        if (!good || !good.is_free || good.is_owned || good.ad_only) return false;
        if (Number(good.price?.count || 0) !== 0) return false;
        if (good.is_available === false) return false;
        const limit = good.purchase_limit;
        if (limit && Number(limit.limit_type) > 0 && Number(limit.limit_count) > 0 && BigInt(limit.bought_count || 0) >= BigInt(limit.limit_count)) return false;
        return true;
    }
    async function listFreeGifts() {
        const gifts = [];
        const errors = [];
        for (const slotType of [6, 7]) {
            try {
                const list = await rpc('GetMallListBySlotType', { slot_type: slotType, is_manual_open: true, global_scene_id: 2 });
                for (const good of list.goods_list || []) if (isFreeMallGood(good)) gifts.push({ slotType, good });
            } catch (err) { errors.push(`slot${slotType}: ${err.message}`); }
        }
        return { gifts, errors };
    }
    // 每日分享礼包 / 每日免费礼包与农场侧一致：没有开关，默认常驻。
    // 由自动化心跳单独驱动，不依赖任何开关；成功或明确已领取后当日不再查，失败 10 分钟退避。
    async function runDailyClaims() {
        const share = dailyRoutine('share'), gift = dailyRoutine('gift');
        const due = slot => !slot.done && now() - slot.lastAt >= DAILY_RETRY_MS;
        if (!due(share) && !due(gift)) return;
        if (!getUserState().gid || operation || automationRunning) return;
        // 未开牧场的账号（农场 25 级解锁）连场景都不用进。
        const level = Number(getUserState().level);
        if (Number.isFinite(level) && level < 25) return;
        if (session.snapshot?.().blockedScenes?.includes('ranch')) return;
        // 每条例程当天连续失败 6 次就放弃，避免坏账号整日刷日志、反复切场景。
        const fail = (slot, err, module, event, label) => {
            slot.failures += 1;
            if (slot.failures >= 6) slot.done = true;
            log('牧场', `${label}${err.message}${slot.done ? '（今日放弃重试）' : ''}`, { scene: 'ranch', module, event, result: 'error' });
        };
        if (due(share)) {
            share.lastAt = now();
            try {
                const can = await rpc('CheckCanShare', {});
                if (can?.can_share) await action({ action: 'claimDailyShare' }, 'autoClaimShare');
                else log('牧场', '牧场分享礼包今日已领取，跳过', { scene: 'ranch', module: ranchOperationModule('claimDailyShare'), event: 'claimDailyShare', result: 'none' });
                share.done = true;
            } catch (err) { fail(share, err, ranchOperationModule('claimDailyShare'), 'claimDailyShare', '自动领取分享礼包失败：'); }
        }
        if (due(gift)) {
            gift.lastAt = now();
            try {
                const { gifts } = await listFreeGifts();
                if (gifts.length) await action({ action: 'claimFreeGift', goodsId: String(gifts[0].good.goods_id) }, 'autoClaimFreeGift');
                else gift.done = true;
            } catch (err) { fail(gift, err, ranchOperationModule('claimFreeGift'), 'claimFreeGift', '自动领取免费礼包失败：'); }
        }
    }
    /**
     * 同一账号的并发快照读合并。
     *
     * getStatus 每次都要进一次牧场场景并打 AllCells + GetRanchDetail + GetBag + GetBagTab +
     * GetOrderPanel + 任务，很占场景锁。多开页面同时刷新时这里把并发的几次读并成一次，
     * 共用同一份快照；不做时间窗口缓存——顺序的两次读必须拿到各自时刻的真实状态，
     * 否则操作前/后的快照会串味。
     */
    let inflightStatus = null;
    function details(input, reply, context = {}) {
        return ranchOperationDetails(input, reply, { itemName: id => itemMap.get(String(id))?.name || animalMap.get(String(id))?.name || `物品 ${id}`, goodsItem: goodsMap.get(String(input.goodsId))?.item_id, ...context });
    }
    function record(action, reply, trigger = 'manual', input = {}, context = {}) {
        syncOperationsDay();
        operations[action] = (operations[action] || 0) + 1;
        scheduleOperationsSave();
        const detail = details(input, reply, context);
        log('牧场', `${trigger === 'automatic' ? '自动' : '手动'}${ACTION_NAMES[action] || action}成功${detail.text ? `：${detail.text}` : ''}`, { scene: 'ranch', module: ranchOperationModule(action), event: action, trigger, result: 'ok', resultCount: reply?.op_results?.length ?? null, ...detail.meta });
    }
    async function exclusive(fn) {
        operation++;
        try {
            return await session.inRanch(async () => {
                session.assertAllowed();
                if (!getUserState().gid) throw new Error('账号尚未登录');
                if (pendingLeave && pendingLeaveEpoch !== session.getEpoch?.()) pendingLeave = null;
                if (pendingLeave && !friendBatch) await leaveFriend(pendingLeave);
                return fn();
            });
        } finally { operation--; }
    }
    // ---------- 面板快照缓存（stale-serve） ----------
    // 概览页的 /api/ranch 读不再直接抢场景锁：worker 层在进场景前先 peek 这份缓存，命中直接回包，
    // 完全不排队（自动化优先）。缓存只喂「本来就要发生」的牧场驻留：getStatus/getResource 真读、
    // action 回包快照、自动化一轮结束时的快照，不产生任何额外场景请求。
    // 写操作后 status 由 action 带回的最新快照覆盖，其余分区作废、由下一次真实读回填；
    // epoch 变化（重新登录）自动失效。
    const PANEL_TTL_MS = { status: 120000, friends: 90000, shop: 30 * 60 * 1000, profile: 150000, illustrated: 240000 };
    const panelCache = new Map();
    function cachePanel(key, data) {
        if (!data) return;
        panelCache.set(key, { at: now(), epoch: session.getEpoch?.() ?? null, data });
    }
    function peekPanel(key) {
        const hit = panelCache.get(key);
        if (!hit) return null;
        if ((session.getEpoch?.() ?? null) !== hit.epoch || now() - hit.at > (PANEL_TTL_MS[key] ?? 60000)) { panelCache.delete(key); return null; }
        return hit.data;
    }
    // 忽略 TTL、只校验登录世代的旧快照：读失败时用它兜底，面板不至于整屏空白。
    function stalePanel(key) {
        const hit = panelCache.get(key);
        if (!hit) return null;
        if ((session.getEpoch?.() ?? null) !== hit.epoch) { panelCache.delete(key); return null; }
        return hit.data;
    }
    function dropPanelExceptStatus() {
        for (const key of [...panelCache.keys()]) if (key !== 'status') panelCache.delete(key);
    }
    async function snapshot(strict = true, light = false) {
        const errors = {};
        async function read(section, method, params, fallback) {
            try { return await rpc(method, params); }
            catch (err) {
                if (strict) throw err;
                errors[section] = err.message;
                return fallback;
            }
        }
        const cells = await read('buildings', 'AllCells', {}, { facilities: [] });
        const ids = (cells.facilities || []).filter(f => f.ranch).map(f => f.ranch.ranch_inst_id);
        // Only query own facilities. No guessed global IDs or friend operations.
        const ranches = ids.length ? (await read('overview', 'GetRanchDetail', { host_gid: String(getUserState().gid), ranch_inst_ids: ids }, { ranches: [] })).ranches : [];
        const bag = await read('warehouse', 'GetBag', { global_scene_id: 2, tab_id: 0 }, {});
        const tabs = light ? {} : await read('tabs', 'GetBagTab', { global_scene_id: 2 }, {});
        let order, orderError;
        try { if (!light || settings().autoSubmitOrders) order = await rpc('GetOrderPanel', {}); } catch (err) { orderError = err.message; }
        if (errors.buildings) errors.overview = `设施读取失败：${errors.buildings}`;
        const state = normalizeSnapshot({ cells, ranches: ranches || [], bag, tabs, order, orderError, serverTime: serverNow(), settings: settings(), farmLevel: getUserState().level });
        if (!light) {
            try { state.tasks = await readTasks(); }
            catch (err) { errors.tasks = err.message; }
        }
        state.sectionErrors = errors;
        syncOperationsDay();
        state.operations = { ...operations };
        state.operationsDate = operationsDate;
        state.lastAutomationAt = lastAutomationAt;
        state.nextChecks = scheduler.status(scheduledSettings(), normalizePolicy(getSettings().ranch_policy));
        state.capabilities = CAPABILITIES;
        if (errors.warehouse) state.currencies = [];
        return state;
    }
    // Compatibility endpoints remain reads; scene acquisition is centralized in the account executor.
    async function connect() { return getStatus(); }
    async function disconnect() { return getStatus(); }
    async function getStatus() {
        if (!getUserState().gid) throw new Error('账号尚未登录');
        if (inflightStatus) return inflightStatus;
        const task = exclusive(() => session.inRanch(() => snapshot(false)));
        inflightStatus = task;
        try {
            const state = await task;
            cachePanel('status', state);
            return state;
        } finally {
            if (inflightStatus === task) inflightStatus = null;
        }
    }
    // Visit state is scoped to one queued transaction; never leave a friend visit open for the web UI.
    let pendingLeave = null;
    let friendBatch = null;
    let pendingLeaveEpoch;
    async function leaveFriend(host) {
        await rpc('LeaveHomestead', { host_gid: host });
        pendingLeave = null;
    }
    async function readTasks() {
        const reply = await rpc('TaskInfo', { global_scene_id: 2 });
        if (!reply?.task_info) throw new Error('牧场任务响应缺少 task_info');
        const info = reply.task_info;
        const rows = info.tasks?.length ? info.tasks : [...(info.growth_tasks || []), ...(info.daily_tasks || [])];
        return [...new Map(rows.filter(t => [4, 5, 6].includes(Number(t.task_type))).map(t => [String(t.id), describeResource(t)])).values()];
    }
    // 牧场成长任务里的「打开好友面板」等由客户端上报进度完成，服务端不会自己推进。
    // 哪些任务属于「客户端上报」由官方任务配置表 MCTask.json 的 condition 字段决定，
    // 不能按 condType 数字硬编码：线上实测 #300008 的 cond=20（旧代码只认 15/25，永远漏掉它）。
    const MC_TASK_CONFIG = new Map(require('../gameConfig/ranch/MCTask.json').map(row => [String(row.id), row]));
    const isClientReportedTaskId = id => MC_TASK_CONFIG.get(String(id))?.condition === '客户端上报进度';
    async function reportClientReportedTasks() {
        const reply = await rpc('TaskInfo', { global_scene_id: 2 });
        const info = reply?.task_info || {};
        const rows = [...(info.tasks || []), ...(info.growth_tasks || []), ...(info.daily_tasks || [])];
        const tasks = [...new Map(rows.map(row => [String(row.id), describeResource(row)])).values()];
        const pending = tasks.filter(task => isClientReportedTaskId(task.id) && task.isUnlocked && !task.isClaimed
            && BigInt(task.totalProgress || 0) > 0n && BigInt(task.progress || 0) < BigInt(task.totalProgress));
        // 诊断：只报「MCTask.json 里查不到的未完成任务」——那些可能是新任务漏配了
        // 客户端上报条目。配置表里查得到的服务端计数任务（等级提升/购买幼崽/收获等）
        // 会随正常自动化推进，属于预期情况，不打日志避免刷屏。
        if (!pending.length) {
            const unknown = tasks.filter(task => task.isUnlocked && !task.isClaimed
                && BigInt(task.totalProgress || 0) > 0n && BigInt(task.progress || 0) < BigInt(task.totalProgress)
                && !MC_TASK_CONFIG.has(String(task.id)));
            if (unknown.length) log('牧场', `未完成任务中 ${unknown.length} 项不在任务配置表里，可能需要补充客户端上报判定：${unknown.slice(0, 10).map(t => `#${t.id}(${t.desc} cond=${t.condType} ${t.progress}/${t.totalProgress})`).join('、')}`, {
                scene: 'ranch', module: ranchOperationModule('claimTask'), event: 'reportTask', result: 'unknown_task',
                tasks: unknown.slice(0, 10).map(t => ({ id: String(t.id), taskType: t.taskType, condType: t.condType, progress: String(t.progress), total: String(t.totalProgress) })),
            });
        }
        const reported = [];
        for (const task of pending) {
            const result = await rpc('ClientReportProgress', { task_id: String(task.id), progress: String(task.totalProgress) });
            const after = result?.task_info || {};
            const updated = [...(after.tasks || []), ...(after.growth_tasks || []), ...(after.daily_tasks || [])]
                .map(row => describeResource(row)).find(t => String(t.id) === String(task.id));
            reported.push({ id: String(task.id), desc: task.desc, ok: !updated || BigInt(updated.progress || 0) >= BigInt(task.totalProgress) });
        }
        return reported;
    }
    const friendListCache = require('./local-friend-cache').createLocalFriendCache({
        key: 'ranch-list', now, scope: () => process.env.FARM_ACCOUNT_ID ? `ranch:${process.env.FARM_ACCOUNT_ID}:${getUserState().gid}` : '',
    });
    // 服务器 GetAll/GetGameFriends 返回的名单成员不稳定（同一账号相邻两次调用成员可能不同），
    // 持久化一份「见过即可访问」的牧场好友花名册：每次成功拉取做并集落盘，作为列表校验的兜底来源。
    function rosterFile() {
        const path = require('node:path');
        const { getDataDir } = require('../config/runtime-paths');
        const dir = friendRosterDir || path.join(getDataDir(), 'ranch-friend-roster');
        return path.join(dir, `${process.env.FARM_ACCOUNT_ID || 'default'}-${getUserState().gid}.json`);
    }
    // 花名册条目 14 天没再出现在服务器名单里就视为已删好友，避免无限膨胀。
    const ROSTER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
    // GetGameFriends 明细单请求最多只回 50 位：2026-11-19 线上实测请求 100/100/71 三批，
    // 每批都恰好只回 50（271 位好友因此只剩 150）。所以分批必须按 50 切。
    const FRIEND_DETAIL_BATCH_SIZE = 50;
    // 首轮没回来的 GID 用更小的批发补查一次（10/批）。
    const FRIEND_RECOVERY_BATCH_SIZE = 10;
    function readFriendRoster(maxAgeMs = 0) {
        let parsed;
        try { parsed = JSON.parse(require('node:fs').readFileSync(rosterFile(), 'utf8')); } catch { return {}; }
        if (!parsed || typeof parsed !== 'object') return {};
        if (!maxAgeMs) return parsed;
        const cutoff = now() - maxAgeMs;
        const fresh = {};
        for (const [gid, seenAt] of Object.entries(parsed)) {
            const at = Number(seenAt) || 0;
            if (at >= cutoff) fresh[gid] = seenAt;
        }
        return fresh;
    }
    function saveFriendRoster(roster) {
        try {
            require('node:fs').mkdirSync(require('node:path').dirname(rosterFile()), { recursive: true });
            require('node:fs').writeFileSync(rosterFile(), JSON.stringify(roster), { mode: 0o600 });
        } catch { /* 花名册落盘失败不影响本次结果。 */ }
    }
    function recordFriendRoster(gids) {
        if (!gids.length) return;
        // 写入时顺带丢弃超期条目，否则已删好友会永久留在磁盘花名册里。
        const roster = readFriendRoster(ROSTER_TTL_MS);
        for (const gid of gids) roster[String(gid)] = now();
        saveFriendRoster(roster);
    }
    // 好友牧场状态预取：GetGameFriends 回包的 big_farm_status 是官方好友列表置顶排序的
    // 数据源（2026-11-19 抓包实证：可偷 steal_lot_count、可接生 midwife_count、可帮 help_count）。
    // 一次批量读（50 个 GID/次）即可知道谁值得进场，替代盲巡访。任一批失败整体返回 null，
    // 调用方回退为全量名单。名单不变时 60 秒内复用上一次结果：好友产物/灾害状态不会秒级变化，
    // 而 help 与 steal 两组会前后脚各跑一次预取，缓存放掉一半重复读。
    const PREFETCH_TTL_MS = 60000;
    let prefetchCache = null;
    async function prefetchFriendRanchStatus(gids) {
        const unique = [...new Set(gids.map(g => String(g)))].filter(Boolean);
        if (!unique.length) return null;
        if (prefetchCache && now() - prefetchCache.at < PREFETCH_TTL_MS
            && prefetchCache.gids.length === unique.length
            && prefetchCache.gids.every((gid, i) => gid === unique[i])) return prefetchCache.map;
        const map = {};
        for (let i = 0; i < unique.length; i += 50) {
            const batch = unique.slice(i, i + 50);
            try {
                const reply = await rpc('GetGameFriends', { friend_gids: batch, global_scene_id: 2 });
                for (const friend of reply.friends || []) {
                    const status = friend.big_farm_status;
                    if (!friend.gid || !status) continue;
                    map[String(friend.gid)] = {
                        canSteal: status.can_steal === true, stealLots: Number(status.steal_lot_count) || 0,
                        canMidwife: status.can_midwife === true, midwifeN: Number(status.midwife_count) || 0,
                        canHelp: status.can_help === true, helpN: Number(status.help_count) || 0,
                    };
                }
            } catch { return null; }
            if (i + 50 < unique.length) await new Promise(resolve => setTimeout(resolve, 200 + Math.floor(Math.random() * 300)));
        }
        if (!Object.keys(map).length) return null;
        if (Object.keys(map).length < unique.length) log('牧场', `状态预取：请求 ${unique.length} 位，只回来 ${Object.keys(map).length} 位状态`, {
            scene: 'ranch', module: 'friend', event: 'prefetch', result: 'partial', requested: unique.length, returned: Object.keys(map).length,
        });
        prefetchCache = { gids: unique, at: now(), map };
        return map;
    }
    function knownFriendPool() {
        return new Set([...(getKnownFriendGids() || []).map(String), ...Object.keys(readFriendRoster(ROSTER_TTL_MS))]);
    }
    async function readFriends(force = false) {
        return friendListCache.get(fetchFriends, force);
    }
    async function fetchFriends() {
        const knownGids = (getKnownFriendGids() || []).map(String)
            .filter(gid => /^[1-9]\d*$/.test(gid) && gid !== String(getUserState().gid));
        let all;
        let legacyFallback = false;
        try {
            all = await rpc('GetAll', { global_scene_id: 2 });
        } catch (err) {
            // QQ's legacy list endpoint can reject GetAll even with the official
            // scene field. Resolve saved GIDs through the current API, as farm does.
            // Never turn transport/auth failures or a missing seed list into success.
            if (!/\bcode=1000020\b/.test(err.message || '') || !knownGids.length) throw err;
            all = { game_friends: [], blocked_players: [] };
            legacyFallback = true;
        }
        const blocked = new Set((all.blocked_players || []).map(f => String(f.gid)));
        // 名单补全：GetAll 每次只回约 150 位、且相邻两次成员不同（线上实测 271 位好友只回 150），
        // 单靠它会让一半好友永远进不了预取和巡访。把持久花名册（历史上见过的全体好友）并入
        // 请求来源，明细接口按 GID 点查，能稳定拿到完整名单。
        const rosterGids = Object.keys(readFriendRoster(ROSTER_TTL_MS));
        const gids = [...new Set([...(all.game_friends || []).map(f => String(f.gid)),
            ...knownGids, ...rosterGids])]
            .filter(gid => /^[1-9]\d*$/.test(gid) && gid !== String(getUserState().gid) && !blocked.has(gid));
        const friends = [];
        const seen = new Set();
        let dropped = 0;
        // 明细点查：GetGameFriends 单请求最多只回 50 位（2026-11-19 线上实测 100→50/100→50/71→50），
        // 所以分批固定 50，剩下的靠「多打几次」而不是靠单次请求的批量。
        // 回包比请求少有两种原因：花名册里含已删好友（正常）、或服务端静默截断（异常）。
        // 用缺失 GID 二次补查把第二种情况捞回来。
        const collect = reply => {
            for (const friend of reply.friends || []) {
                const gid = String(friend.gid);
                if (blocked.has(gid) || seen.has(gid)) continue;
                seen.add(gid); friends.push(friend);
            }
        };
        const queryBatches = async (list, size) => {
            // 单批失败二分重试：花名册里可能有已删好友，整批丢弃会连带漏掉同批正常好友。
            const queue = [];
            for (let offset = 0; offset < list.length; offset += size) queue.push(list.slice(offset, offset + size));
            while (queue.length) {
                const batch = queue.shift();
                try {
                    const reply = await rpc('GetGameFriends', { friend_gids: batch, global_scene_id: 2 });
                    collect(reply);
                } catch (err) {
                    if (batch.length > 5) {
                        const mid = Math.ceil(batch.length / 2);
                        queue.unshift(batch.slice(0, mid), batch.slice(mid));
                    } else dropped += batch.length;
                }
                if (queue.length) await new Promise(resolve => setTimeout(resolve, 150 + Math.floor(Math.random() * 200)));
            }
        };
        await queryBatches(gids, FRIEND_DETAIL_BATCH_SIZE);
        // 补查：只查第一次没回来的 GID，批更小（10），服务端即便有截断也一定装得下。
        let missing = gids.filter(gid => !seen.has(gid));
        if (missing.length) {
            await queryBatches(missing, FRIEND_RECOVERY_BATCH_SIZE);
            missing = gids.filter(gid => !seen.has(gid));
            if (missing.length) log('牧场', `好友名单有 ${missing.length} 位补查后仍未返回（可能是已删好友）`, {
                scene: 'ranch', module: 'friend', result: 'partial', gids: gids.length, friends: friends.length,
            });
        }
        if (dropped) log('牧场', `好友明细有 ${dropped} 位查询失败已跳过（花名册中可能含已删好友）`, {
            scene: 'ranch', module: 'friend', result: 'partial', gids: gids.length, friends: friends.length,
        });
        if (dropped) log('牧场', `好友明细有 ${dropped} 位查询失败已跳过（花名册中可能含已删好友）`, {
            scene: 'ranch', module: 'friend', result: 'partial', gids: gids.length, friends: friends.length,
        });
        // 服务器限频会降级：列表端点返回空名单、或详情端点一个好友都不回。历史可见好友存在
        // 而结果为空（且非 blocked 过滤所致）视为异常，抛错保留上一次的完好缓存。
        if (!legacyFallback && knownFriendPool().size && !friends.length
            && (!(all.game_friends || []).length || gids.length))
            throw new Error('牧场好友列表返回为空（服务器疑似限频降级），本次结果不入缓存');
        // 名单成员波动：成功获取后把全体成员并入持久花名册
        recordFriendRoster(friends.map(f => f.gid));
        return { friends, blocked_players: all.blocked_players || [] };
    }
    async function friendAction(input, mutate, trigger) {
        const host = String(input.hostGid || '');
        if (!/^[1-9]\d*$/.test(host) || host === String(getUserState().gid)) throw new Error('无效好友牧场');
        const knownFriends = knownFriendPool();
        let all;
        try {
            all = await readFriends(trigger === 'manual' && !friendBatch);
        } catch (err) {
            // 列表刷新撞上限频降级时回落到上一次的完好缓存；缓存也不可用时，
            // 名单认识的好友仍直接进场景由服务器裁决（ref 上游本就不预校验列表）。
            if (!/限频降级/.test(err.message || '')) throw err;
            try { all = await readFriends(false); } catch { all = { friends: [], blocked_players: [] }; }
            if (!all.friends.length && !knownFriends.has(host)) throw err;
        }
        // 列表可能被降级响应污染：被拉黑、且农场好友名单里也找不到的才拒绝；
        // 名单认识但列表缺项的直接进场景，由服务器裁决。
        if ((all.blocked_players || []).some(f => String(f.gid) === host)
            || (!all.friends.some(f => String(f.gid) === host) && !knownFriends.has(host)))
            throw new Error('目标不是可访问的好友');
        const visitEpoch = session.getEpoch?.();
        if (friendBatch && friendBatch.host !== host) throw new Error('禁止在好友访问事务中切换好友');
        const entered = friendBatch?.entered || await rpc('EnterHomestead', { host_gid: host, reason: 2 });
        if (friendBatch) friendBatch.entered = entered;
        pendingLeave = host;
        pendingLeaveEpoch = visitEpoch;
        let result, actionError;
        try {
            const cells = friendBatch?.state?.cells || entered.homestead_cells || await rpc('AllCells', {});
            const ids = (cells.facilities || []).filter(f => f.ranch).map(f => f.ranch.ranch_inst_id);
            const load = async () => ids.length ? (await rpc('GetRanchDetail', { host_gid: host, ranch_inst_ids: ids })).ranches || [] : [];
            let ranches = friendBatch?.state?.ranches || await load();
            let ops = friendBatch?.state?.ops || (await rpc('GetRanchOpTimes', {})).ops || [];
            const ranch = ranches.find(r => String(r.ranch_inst_id) === String(input.ranchId));
            const remaining = id => BigInt(ops.find(o => String(o.op_id) === id)?.remaining_times || 0);
            let reply;
            if (input.action !== 'visitFriend') {
                if (!ranch && input.action !== 'friendFeed') throw new Error('好友栏舍已不存在，请重新查看');
                if (input.action === 'friendFeed') {
                    // 客态加草：官方 GrassMachineSyncHelper 用 host_gid 指向被访问的家园。
                    // use_gold=false 只用仓库牧草；use_gold=true 用金券把牧草机补到容量（2026-11-18 抓包：
                    // 每次 AddFeed 服务器按 60 金券/单位扣 1007，仓库牧草不动，回包 detail.feed_count=capacity）。
                    const facility = (cells.facilities || []).find(f => String(f.instance_id) === String(input.facilityInstId));
                    let capacity = Number(facility?.capacity);
                    let feedCount = facility?.feed_machine ? Number(facility.feed_machine.feed_count) : NaN;
                    // 好友家园快照未必带 feed_machine：按官方客户端做法补一次客态详情读。
                    if (!Number.isFinite(feedCount) || !(capacity > 0)) {
                        const detail = (await rpc('GetFacilityDetail', { instance_id: String(input.facilityInstId), host_gid: host })).info;
                        if (!detail?.feed_machine) throw new Error('好友牧草机已不存在，请重新查看');
                        capacity = Number(detail.capacity);
                        feedCount = Number(detail.feed_machine.feed_count);
                    }
                    if (!(capacity > 0) || !Number.isFinite(feedCount)) throw new Error('好友牧草机状态不可用，请重新查看');
                    if (input.useGold === true) {
                        const gap = capacity - feedCount;
                        if (!(gap > 0)) throw new Error('好友牧草机已经满了');
                        const cost = BigInt(gap) * FEED_GOLD_UNIT_COST;
                        const bag = await rpc('GetBag', {});
                        const balance = [...(bag.physical_items || []), ...(bag.virtual_items || [])]
                            .filter(i => String(i.id) === GOLD_ITEM_ID && !i.locked && !i.is_locked && !i.isLocked)
                            .reduce((total, i) => total + BigInt(i.count || 0), 0n);
                        const reserve = BigInt(normalizePolicy(getSettings().ranch_policy).goldReserve);
                        if (balance - cost < reserve) throw new Error(`金券不足：补满 ${gap} 单位需 ${cost} 金券（保留 ${reserve}，当前 ${balance}）`);
                        reply = await mutate('AddFeed', { instance_id: String(input.facilityInstId), add_count: gap, use_gold: true, host_gid: host });
                        input = { ...input, count: gap, useGold: true, goldCost: String(cost) };
                    } else {
                        const count = input.count;
                        if (!Number.isInteger(count) || count <= 0 || count > 2147483647) throw new Error('牧草数量必须为正整数');
                        if (count > capacity - feedCount) throw new Error('超过好友牧草机剩余容量');
                        reply = await mutate('AddFeed', { instance_id: String(input.facilityInstId), add_count: count, use_gold: false, host_gid: host });
                    }
                } else if (input.action === 'friendProduce') {
                    const animal = (ranch.animals || []).find(a => String(a.animal_inst_id) === String(input.animalInstId));
                    if (!animal || animal.stage !== 3 || animal.producing || animal.can_deliver !== true) throw new Error('好友动物当前不可生产');
                    reply = await mutate('TriggerProduce', { host_gid: host, targets: [{ ranch_inst_id: String(ranch.ranch_inst_id), animal_inst_id: animal.animal_inst_id }] });
                } else if (input.action === 'steal') {
                    if (input.stealAll === true && input.slotIndex == null) {
                        // 一键偷取：空 targets 由服务端筛选当前全部可偷货架（官方客户端一键偷取同款，
                        // 每个好友 1 条写请求替代逐货架 N 条）。回包逐条核对 kind===2 且带奖励，防重复提交。
                        reply = await mutate('StealProduce', { host_gid: host, targets: [] });
                        input = { ...input, stolenCount: (reply?.op_results || []).filter(r => r.kind === 2 && (r.rewards || []).length).length };
                    } else {
                        const shelf = (ranch.shelves || []).find(v => v.slot_index === input.slotIndex && v.can_steal);
                        if (!shelf) throw new Error('该货架当前不可偷取');
                        reply = await mutate('StealProduce', { host_gid: host, targets: [{ ranch_inst_id: String(ranch.ranch_inst_id), slot_index: shelf.slot_index }] });
                    }
                } else if (input.action === 'help') {
                    if (!(ranch.hazards || []).length) throw new Error('该栏舍当前没有可清理的灾害');
                    reply = await mutate('CleanAllRanch', { host_gid: host, ranch_inst_ids: [String(ranch.ranch_inst_id)] });
                } else if (input.action === 'stroke') {
                    const animal = (ranch.animals || []).find(a => String(a.animal_inst_id) === String(input.animalInstId));
                    if (!animal?.mutation?.strokable || Number(animal.mutation.mutation_type || 0) !== 0 || (animal.mutation.stroked_gids || []).some(g => String(g) === String(getUserState().gid))) throw new Error('该动物当前不可照料或已照料');
                    if (remaining('11009') <= 0n) throw new Error('今日照料次数已用尽或未取得限额');
                    reply = await mutate('StrokeAnimal', { host_gid: host, target: { ranch_inst_id: String(ranch.ranch_inst_id), animal_inst_id: animal.animal_inst_id } });
                } else if (input.action === 'putHazard') {
                    if (remaining('11003') <= 0n) throw new Error('今日放蚊子次数已用尽或未取得限额');
                    reply = await mutate('PutHazard', { host_gid: host, ranch_inst_id: String(ranch.ranch_inst_id), op_id: '11003', count: '1' });
                }
                record(input.action, reply, trigger, input, { state: normalizeSnapshot({ cells, ranches, bag: {}, tabs: {}, settings: settings() }), friendName: all.friends.find(f => String(f.gid) === host)?.name });
                // Never reclassify a completed mutation as failed if a subsequent read fails.
                try { ranches = await load(); ops = (await rpc('GetRanchOpTimes', {})).ops || []; }
                catch (err) { result = { refreshError: err.message }; ranches = []; ops = []; }
            }
            if (friendBatch) friendBatch.state = result?.refreshError ? null : { cells, ranches, ops };
            const snapshot = normalizeSnapshot({ cells, ranches, bag: {}, tabs: {}, settings: settings() });
            result = { ...result, action: input.action, reply: describeResource(reply), friend: { hostGid: host, facilities: snapshot.facilities, ranches: snapshot.ranches.map(r => ({ ...r, animals: r.animals.map(a => ({ ...a, canStroke: !!a.mutation?.strokable && Number(a.mutation.mutationType || 0) === 0 && !(a.mutation.strokedGids || []).some(g => String(g) === String(getUserState().gid)) && remaining('11009') > 0n })) })), ops: camelize(ops) } };
        } catch (err) { if (friendBatch) friendBatch.state = null; actionError = err; }
        try { if (!friendBatch) await leaveFriend(host); }
        catch (err) {
            log('牧场', `退出好友牧场失败：${err.message}`, { scene: 'ranch', module: ranchOperationModule('leaveFriend'), event: 'leaveFriend', result: 'error' });
            if (!actionError) result = { ...result, warning: '操作已完成，但退出好友牧场失败；后续请求将先重试退出，请勿重复操作。' };
        }
        if (actionError) throw actionError;
        return result;
    }
    async function withFriendVisit(host, fn) {
        return exclusive(async () => {
            if (friendBatch) throw new Error('禁止嵌套好友访问事务');
            friendBatch = { host: String(host), entered: null };
            let result, failure;
            try { result = await fn(); } catch (err) { failure = err; }
            const entered = friendBatch.entered;
            friendBatch = null;
            if (entered) {
                try { session.assertAllowed(); await leaveFriend(String(host)); }
                catch (err) {
                    log('牧场', `退出好友牧场失败：${err.message}`, { scene: 'ranch', module: 'friend', event: 'leaveFriend', result: 'error' });
                    if (!failure) result = { ...result, warning: '操作已完成，但退出好友牧场未确认，请刷新核对结果。' };
                }
            }
            if (failure) throw failure;
            return result;
        });
    }
    async function action(input, automationKey = null) {
        // 自动化触发才排队（见 AUTOMATION_ACTION_GAP_MS）；面板手动操作保持即时。
        if (automationKey) await paceAutomationWrite();
        if (input.action === 'batchFriend') {
            if (automationKey || !['steal', 'help', 'stroke', 'putHazard'].includes(input.operation)) throw new Error('无效好友批量操作');
            return withFriendVisit(input.hostGid, async () => {
                await readFriends(true);
                let result = await action({ action: 'visitFriend', hostGid: input.hostGid });
                const attempted = new Set();
                let completed = 0;
                while (!result.refreshError && !result.warning && completed < 50) {
                    session.assertAllowed();
                    const op = input.operation;
                    const detail = result.friend;
                    const remaining = id => BigInt(detail?.ops?.find(row => String(row.opId) === id)?.remainingTimes || 0);
                    if ((op === 'stroke' && remaining('11009') <= 0n) || (op === 'putHazard' && remaining('11003') <= 0n)) break;
                    const targets = (detail?.ranches || []).flatMap(r => {
                        const base = { action: op, hostGid: input.hostGid, ranchId: r.ranchInstId };
                        if (op === 'steal') return r.shelves.filter(v => v.canSteal).map(v => ({ ...base, slotIndex: v.slotIndex }));
                        if (op === 'help') return r.hazards.length ? [base] : [];
                        if (op === 'stroke') return r.animals.filter(v => v.canStroke).map(v => ({ ...base, animalInstId: v.animalInstId }));
                        return [base];
                    });
                    const target = targets.find(v => !attempted.has(JSON.stringify(v)));
                    if (!target) break;
                    attempted.add(JSON.stringify(target));
                    try { result = await action(target); completed++; }
                    catch (err) {
                        session.assertAllowed();
                        return { ...result, completed, batchError: err.message };
                    }
                }
                return { ...result, completed };
            });
        }
        const trigger = automationKey ? 'automatic' : 'manual';
        return exclusive(() => session.inRanch(async () => {
            const autoContext = {};
            const check = () => {
                if (!automationKey) return;
                if (['visitFriend', 'steal', 'friendProduce', 'help', 'stroke', 'putHazard', 'friendFeed'].includes(input.action) && quietNow(normalizePolicy(getSettings().ranch_policy), now())) throw new Error('当前处于好友静默时段');
                const upgradeKey = ['activateFacility', 'upgradeBuilding', 'completeUpgrade'].includes(input.action) && ['autoUpgradeRanch', 'autoUpgradeFacilities'].includes(automationKey);
                if (upgradeKey) {
                    const facility = autoContext.state?.facilities.find(f => String(f.instId) === String(input.facilityInstId));
                    if (!facility || (facility.facilityKind === 'MODULE_TYPE_MAIN_CITY') !== (automationKey === 'autoUpgradeRanch')) throw new Error('升级开关与建筑类型不符');
                }
                const exchangeKey = input.action === 'exchange' && ['autoExchangePoop', 'autoExchangePine'].includes(automationKey);
                if ((exchangeKey ? (input.costItemId !== (automationKey === 'autoExchangePoop' ? '7002' : '1008')) : (!upgradeKey && ACTION_SWITCH[input.action] !== automationKey)) || !settings()[automationKey]) throw new Error('牧场自动任务已关闭');
                autoContext.simpleExchange = exchangeKey;
                if (input.action === 'feedAnimal') {
                    const p = normalizePolicy(getSettings().ranch_policy);
                    const animal = autoContext.state?.ranches.find(r => String(r.ranchInstId) === String(input.ranchId))?.animals.find(a => String(a.animalInstId) === String(input.animalInstId));
                    if (!animal || !feedTypes(animal, p, now()).includes(input.bucketType)) throw new Error('罐头策略已变化');
                }
                autoContext.exchangeEnabled = settings().autoExchange;
                assertAutomationPolicy(input, normalizePolicy(getSettings().ranch_policy), autoContext);
            };
            const mutate = async (method, params) => { check(); return rpc(method, params); };
            if (automationKey && !settings()[automationKey]) return { skipped: true };
            if (['visitFriend', 'steal', 'friendProduce', 'help', 'stroke', 'putHazard', 'friendFeed'].includes(input.action)) {
                if (automationKey) check();
                return friendAction(input, mutate, trigger);
            }
            if (input.action === 'exchange') {
                if (!Number.isSafeInteger(input.count) || input.count <= 0 || input.count > 99) throw new Error('兑换数量必须为 1 至 99 的整数');
                const shop = await rpc('RotationShopInfo', { shop_id: 7 });
                if (!shop.opened || !shop.present) throw new Error('仓鼠驿站当前未营业');
                if (String(input.periodDay) !== String(shop.period_day) || input.roundIndex !== shop.round_index) throw new Error('商品轮次已更新，请刷新后重新确认');
                const goods = (shop.goods || []).find(g => String(g.goods_id) === String(input.goodsId));
                if (!goods) throw new Error('兑换商品已下架');
                if (!['7002', '1008'].includes(String(goods.cost_item_id))) throw new Error('该兑换使用未开放的付费资源');
                for (const cond of goods.buy_conds || []) {
                    if (cond.type !== '最低等级' || !/^\d+$/.test(String(cond.params))) throw new Error('兑换条件尚未确认，暂不兑换');
                    if (Number(getUserState().level) < Number(cond.params)) throw new Error('账号等级未达到兑换条件');
                }
                if (Number(goods.limit_count) > 0 && BigInt(goods.limit_used || 0) + BigInt(input.count) > BigInt(goods.limit_count)) throw new Error('超过剩余兑换限额');
                const seconds = now() / 1000;
                const discounted = Number(goods.discount_price) > 0 && seconds >= Number(goods.discount_start_time) && seconds < Number(goods.discount_end_time);
                const price = String(discounted ? goods.discount_price : goods.cost_count);
                if (!/^\d+$/.test(price) || String(input.costCount) !== price || String(input.costItemId) !== String(goods.cost_item_id)) throw new Error('兑换价格已变动，请刷新后重新确认');
                const bag = await rpc('GetBag', { global_scene_id: 2, tab_id: 0 });
                const balance = [...(bag.physical_items || []), ...(bag.virtual_items || [])].filter(i => String(i.id) === String(goods.cost_item_id) && !i.locked && !i.is_locked).reduce((n, i) => n + BigInt(i.count || 0), 0n);
                if (balance < BigInt(price) * BigInt(input.count)) throw new Error('兑换物品余额不足');
                autoContext.market = { balance, itemId: String(goods.item_id), itemCount: Number(goods.item_count), price: BigInt(price), costItemId: String(goods.cost_item_id), bag };
                const reply = await mutate('RotationBuyGoods', { goods_id: String(goods.goods_id), count: input.count, period_day: String(shop.period_day), round_index: shop.round_index });
                record(input.action, reply, trigger, input, { state: autoContext.state });
                return { reply: describeResource(reply) };
            }
            if (input.action === 'buy') {
                const row = goodsMap.get(String(input.goodsId));
                if (!row || ![5, 6].includes(row.shop_id)) throw new Error('商品不属于牧场商店');
                if (row.price_id !== 1007) throw new Error('只支持金券购买，其他付费资源不开放');
                if (!Number.isSafeInteger(input.count) || input.count <= 0 || input.count > Math.min(row.one_buy_count || 99, 999)) throw new Error('购买数量超过单次上限');
                const shop = await rpc('ShopInfo', { shop_id: row.shop_id });
                const goods = (shop.goods_list || []).find(g => String(g.id) === String(input.goodsId));
                if (!goods || !goods.unlocked || goods.owned) throw new Error('商品尚未解锁、已拥有或已下架');
                if (Number(goods.limit_count) > 0 && BigInt(goods.bought_num || 0) + BigInt(input.count) > BigInt(goods.limit_count)) throw new Error('超过剩余购买限额');
                const price = String(goods.price);
                if (!/^\d+$/.test(price) || String(input.price) !== price) throw new Error('商品价格已变动，请刷新后重新确认');
                // Reject active discounts until their BuyGoods price contract is confirmed.
                const second = now() / 1000;
                if (Number(goods.discount_price) > 0 && second >= Number(goods.discount_start_time) && second < Number(goods.discount_end_time)) throw new Error('限时折扣价格语义待确认，暂不购买');
                const bag = await rpc('GetBag', { global_scene_id: 2, tab_id: 0 });
                const balance = [...(bag.physical_items || []), ...(bag.virtual_items || [])].filter(i => String(i.id) === '1007' && !i.locked && !i.is_locked).reduce((n, i) => n + BigInt(i.count || 0), 0n);
                if (balance < BigInt(price) * BigInt(input.count)) throw new Error('金券不足');
                autoContext.market = { balance, itemId: String(row.item_id), itemCount: Number(row.item_count), price: BigInt(price), costItemId: '1007', bag };
                const reply = await mutate('BuyGoods', { goods_id: String(goods.id), num: String(input.count), price, auto_add: false });
                record(input.action, reply, trigger, input, { state: autoContext.state });
                return { reply: describeResource(reply) };
            }
            if (input.action === 'claimTask') {
                if (typeof input.taskId !== 'string' || !/^[1-9]\d{0,18}$/.test(input.taskId)) throw new Error('无效牧场任务 ID');
                // Always re-read the ranch scene: never trust page data or farm task IDs.
                const task = (await readTasks()).find(t => String(t.id) === input.taskId);
                if (!task || ![4, 5].includes(Number(task.taskType)) || !task.isUnlocked || task.isClaimed ||
                    BigInt(task.totalProgress || 0) <= 0n || BigInt(task.progress || 0) < BigInt(task.totalProgress)) {
                    throw new Error('牧场任务未完成、未解锁或已领取');
                }
                // Match farm task.doClaim: shared reward is selected from live shareMultiple.
                // Ranch daily tasks retain the official batch RPC (no shared flag).
                const doShared = Number(task.shareMultiple) > 1;
                const reply = Number(task.taskType) === 5
                    ? await mutate('BatchClaimTaskReward', { ids: [input.taskId] })
                    : await mutate('ClaimTaskReward', { id: input.taskId, do_shared: doShared });
                if (!reply?.task_info) throw new Error('牧场领奖响应缺少 task_info');
                record(input.action, reply, trigger, input, { state: autoContext.state });
                return { reply: describeResource(reply) };
            }
            if (input.action === 'claimIllustrated' || input.action === 'claimWeight') {
                let reply;
                if (input.action === 'claimIllustrated') {
                    const list = await rpc('GetIllustratedListV2', { rarity: 0, type: 101 });
                    if (!list.has_claimable_reward) throw new Error('当前没有可领取的牧场图鉴奖励');
                    reply = await mutate('ClaimAllRewardsV2', { type: 101 });
                } else {
                    if (!Number.isSafeInteger(input.id) || input.id <= 0) throw new Error('无效重量积分奖励');
                    const score = await rpc('GetRanchWeightScoreV2', {});
                    const level = (score.levels || []).find(row => row.id === input.id);
                    if (!level || !level.can_claim || level.claimed) throw new Error('重量积分奖励未达到条件或已领取');
                    reply = await mutate('ClaimRanchWeightScoreRewardV2', { id: input.id });
                }
                record(input.action, reply, trigger, input, { state: autoContext.state });
                return { reply: describeResource(reply) };
            }
            if (input.action === 'claimDailyShare') {
                // 官方 Share 表：102=牧场每日分享（奖励 80021×5），与农场分享（1）独立。
                // 2026-11-18 抓包（记录 159）实测官方顺序：CheckCanShare → ReportShare(102, doc_id=2102) → ClaimShareReward(102)。
                // CheckCanShare 只代表分享入口可用，不代表今天没领过；重复领取由 ClaimShareReward 回 1009001。
                const can = await rpc('CheckCanShare', {});
                if (!can || !can.can_share) throw new Error('牧场分享入口当前不可用');
                await mutate('ReportShare', { share_id: DAILY_SHARE.id, doc_id: DAILY_SHARE.docId });
                let reply;
                try {
                    reply = await mutate('ClaimShareReward', { share_id: DAILY_SHARE.id });
                } catch (err) {
                    // 1009001「分享奖励已经领取」是幂等结果，不是失败：当天已被官方客户端或其它进程领过。
                    if (!/1009001|已经领取/.test(err.message || '')) throw err;
                    log('牧场', '牧场分享礼包今日已领取', { scene: 'ranch', module: ranchOperationModule('claimDailyShare'), event: 'claimDailyShare', result: 'none' });
                    return { reply: { rewards: [], alreadyClaimed: true } };
                }
                if (!(reply.rewards || []).length) throw new Error('牧场分享奖励回包为空（分享上报未确认）');
                record(input.action, reply, trigger, input, { state: autoContext.state });
                return { reply: describeResource(reply) };
            }
            if (input.action === 'claimFreeGift') {
                // 牧场罐头商城（mallpb, scene 2）的免费礼包：is_free + 零价，Purchase 即领取。
                const { gifts, errors } = await listFreeGifts();
                if (!gifts.length) {
                    if (errors.length && errors.length === 2) throw new Error(`免费礼包列表读取失败：${errors.join('；')}`);
                    throw new Error('当前没有可领取的免费礼包');
                }
                const target = input.goodsId
                    ? gifts.find(entry => String(entry.good.goods_id) === String(input.goodsId))
                    : gifts[0];
                if (!target) throw new Error('免费礼包已领取或已下架');
                const reply = await mutate('Purchase', { goods_id: String(target.good.goods_id), count: 1 });
                if (!reply || !reply.success) throw new Error('领取免费礼包失败');
                record(input.action, reply, trigger, { ...input, goodsName: target.good.name }, { state: autoContext.state });
                return { reply: describeResource(reply), gifts: gifts.map(entry => ({ slotType: entry.slotType, goodsId: String(entry.good.goods_id), name: entry.good.name })) };
            }
            const allowed = ['collect', 'clean', 'place', 'produce', 'harvest', 'addFeed', 'submitOrder', 'refreshOrder', 'feedAnimal', 'activateFacility', 'upgradeBuilding', 'completeUpgrade', 'sell', 'useCan'];
            if (!allowed.includes(input.action)) throw new Error('不支持的牧场动作');
            const state = await snapshot(true, !!automationKey);
            autoContext.state = state;
            let reply;
            if (input.action === 'sell' || input.action === 'useCan') {
                const rows = input.action === 'sell' && input.items ? input.items : [input];
                if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new Error('无效出售列表');
                const seen = new Set();
                const items = rows.map(row => {
                    const key = `${row.itemId}:${row.uid || '0'}`;
                    if (seen.has(key)) throw new Error('出售列表包含重复物品');
                    seen.add(key);
                    if (!Number.isSafeInteger(row.count) || row.count <= 0 || (input.action !== 'sell' && row.count > 99999)) throw new Error('数量必须为有效正整数（罐头最多 99999）');
                    const item = state.items.find(i => String(i.id) === String(row.itemId) && String(i.uid || '0') === String(row.uid || '0'));
                    if (!item || item.locked || BigInt(item.count || 0) < BigInt(row.count)) throw new Error('物品不存在、已锁定或可用数量不足');
                    if (input.action === 'sell' && !item.canSell) throw new Error('仅支持出售未锁定的牧场产物');
                    if (input.action === 'useCan' && !item.canUseCan) throw new Error('仅支持已有牧场罐头装填');
                    return { id: String(item.id), uid: String(item.uid || '0'), count: String(row.count) };
                });
                reply = await mutate(input.action === 'sell' ? 'Sell' : 'BatchUse', { items });
            } else if (input.action === 'feedAnimal') {
                if (![1, 2].includes(input.bucketType)) throw new Error('无效罐头容器类型');
                const ranch = state.ranches.find(r => String(r.ranchInstId) === String(input.ranchId));
                const animal = ranch?.animals.find(a => String(a.animalInstId) === String(input.animalInstId));
                if (!animal || !animal.canFeed || animal.canHarvest) throw new Error('动物当前不可使用罐头容器');
                if (input.bucketType === 2 && animal.limitedCanUsed) throw new Error('该动物已使用本阶段受限罐头');
                const itemId = input.bucketType === 1 ? '7004' : '7003';
                const seconds = state.items.filter(i => String(i.id) === itemId && !i.locked).reduce((n, i) => n + BigInt(i.count || 0), 0n);
                if (seconds <= 0n) throw new Error('罐头容器剩余时长不足，不自动补充或购买');
                reply = await mutate('FeedAnimal', { targets: [{ ranch_inst_id: String(ranch.ranchInstId), animal_inst_id: animal.animalInstId }], bucket_type: input.bucketType });
            } else if (input.action === 'activateFacility') {
                // READY=3 is server-authoritative; never activate a virtual/locked cover.
                const facility = state.facilities.find(f => String(f.instId) === String(input.facilityInstId));
                if (!facility || facility.facilityKind !== 'MODULE_TYPE_RANCH_SHED' || Number(facility.state) !== 3 || facility.upgradeState) throw new Error('棚尚未达到可解锁状态或已解锁');
                // Official ActivateFacility is a free READY→NORMAL activation, not BuyBuilding.
                reply = await mutate('ActivateFacility', { instance_id: String(facility.instId) });
                if (String(reply?.facility?.instance_id) !== String(facility.instId) || Number(reply.facility.state) !== 1) throw new Error('解锁棚响应缺少有效设施状态，请刷新后确认');
            } else if (input.action === 'upgradeBuilding' || input.action === 'completeUpgrade') {
                const facility = state.facilities.find(f => String(f.instId) === String(input.facilityInstId));
                if (!facility) throw new Error('设施不属于当前账号或已不存在');
                if (input.action === 'completeUpgrade') {
                    if (!facility.upgradeState || !(Number(facility.upgradeEndTime) > 0) || Number(facility.upgradeEndTime) * 1000 > now()) throw new Error('设施升级尚未到期');
                    reply = await mutate('CompleteBuildingUpgrade', { inst_id: String(facility.instId) });
                } else {
                    const blocked = upgradeBlockReason(facility, state, getUserState().level);
                    if (blocked) throw new Error(blocked);
                    const details = await rpc('GetFacilityDetail', { instance_id: String(facility.instId), host_gid: String(getUserState().gid) });
                    const costs = details.info?.upgrade_cost || [];
                    const signature = rows => JSON.stringify(rows.map(i => [String(i.id), String(i.count)]).sort((a, b) => a[0].localeCompare(b[0])));
                    if (!costs.length || !Array.isArray(input.costs) || signature(costs) !== signature(input.costs)) throw new Error('升级费用已变动，请刷新后重新确认');
                    for (const cost of costs) {
                        if (String(cost.id) !== '1007' || !/^\d+$/.test(String(cost.count))) throw new Error('不使用未开放的付费资源升级');
                        const balance = state.items.filter(i => String(i.id) === '1007' && !i.locked).reduce((n, i) => n + BigInt(i.count || 0), 0n);
                        if (balance < BigInt(cost.count)) throw new Error('金券不足，无法升级设施');
                    }
                    reply = await mutate('UpgradeBuilding', { inst_id: String(facility.instId) });
                }
            } else if (input.action === 'addFeed') {
                const facility = state.facilities.find(f => String(f.instId) === String(input.facilityInstId));
                if (!facility?.feedMachine) throw new Error('牧草机不属于当前账号或已不存在');
                const capacity = Number(facility.capacity);
                if (!(capacity > 0)) throw new Error('牧草机状态不可用，请刷新后重试');
                const feedCount = Number(facility.feedMachine.feedCount);
                if (input.useGold === true) {
                    // 金券兜底：与好友加草同协议（AddFeed use_gold=true，60 金券/单位），只用于自己的牧草机，
                    // 补到容量为止；host_gid=0 表示自己家园。受 ranch_policy.addFeedUseGold 开关与 goldReserve 保留量约束。
                    const gap = capacity - feedCount;
                    if (!(gap > 0)) throw new Error('牧草机已经满了');
                    const cost = BigInt(gap) * FEED_GOLD_UNIT_COST;
                    const balance = state.items.filter(i => String(i.id) === GOLD_ITEM_ID && !i.locked && !i.is_locked && !i.isLocked).reduce((n, i) => n + BigInt(i.count || 0), 0n);
                    const reserve = BigInt(normalizePolicy(getSettings().ranch_policy).goldReserve);
                    if (balance - cost < reserve) throw new Error(`金券不足：补满 ${gap} 单位需 ${cost} 金券（保留 ${reserve}，当前 ${balance}）`);
                    reply = await mutate('AddFeed', { instance_id: String(facility.instId), add_count: gap, use_gold: true, host_gid: '0' });
                    input = { ...input, count: gap, useGold: true, goldCost: String(cost) };
                } else {
                    const count = input.count;
                    if (!Number.isInteger(count) || count <= 0 || count > 2147483647) throw new Error('牧草数量必须为正整数');
                    const owned = state.items.filter(i => String(i.id) === '7001' && !i.locked && !i.is_locked).reduce((sum, i) => sum + BigInt(i.count || 0), 0n);
                    if (owned < BigInt(count)) throw new Error('牧草库存不足，不自动使用货币购买');
                    if (count > capacity - feedCount) throw new Error('超过牧草机剩余容量');
                    // Official GrassMachineSyncHelper uses watchGid: zero means self home,
                    // a positive gid denotes a visited home (even when it equals our account gid).
                    reply = await mutate('AddFeed', { instance_id: String(facility.instId), add_count: count, use_gold: false, host_gid: '0' });
                }
            } else if (input.action === 'submitOrder' || input.action === 'refreshOrder') {
                const order = state.orders.find(o => o.slotIndex === input.slotIndex && o.instanceId === input.instanceId);
                if (!order) throw new Error('订单已刷新或不存在，请刷新后重试');
                if (input.action === 'submitOrder') {
                    if (!order.canSubmit) throw new Error('订单尚不可提交或提交次数已用尽');
                    // Never consume currencies or locked/special instance items via an implicit order.
                    for (const req of order.requirements) {
                        if (!req.tabIds.includes(5)) throw new Error('该订单消耗物品尚未确认安全，暂不提交');
                        const owned = state.items.filter(i => String(i.id) === String(req.id) && !i.locked && !i.detail?.ranchProduct).reduce((sum, i) => sum + BigInt(i.count || 0), 0n);
                        if (owned < BigInt(req.count || 0)) throw new Error('订单可用库存不足或含锁定/特殊物品');
                    }
                    reply = await mutate('SubmitOrder', { slot_index: order.slotIndex, instance_id: order.instanceId });
                } else {
                    if (!order.canRefresh) throw new Error('订单刷新次数已用尽');
                    reply = await mutate('RefreshOrder', { slot_index: order.slotIndex });
                }
            } else {
                const id = String(input.ranchId ?? '');
                if (!/^[1-9]\d*$/.test(id)) throw new Error('无效窝棚实例');
                const ranch = state.ranches.find(r => String(r.ranchInstId) === id);
                if (!ranch) throw new Error('窝棚不属于当前账号或已不存在');
                if (input.action === 'collect') {
                    if (!ranch.shelves.some(s => s.canCollect)) throw new Error('当前没有可收集的货架产物');
                    reply = await mutate('HarvestRanch', { ranch_inst_ids: [id], op: 2, animals: [], shelves: [] });
                } else if (input.action === 'clean') {
                    const hazards = ranch.hazards || [];
                    if (!hazards.length) throw new Error('当前没有可清理的灾害');
                    reply = await mutate('CleanRanch', { host_gid: String(getUserState().gid), hazard_ids: hazards.map(h => h.hazardId) });
                } else if (input.action === 'place') {
                    if (Number(ranch.animalCount) >= Number(ranch.capacity)) throw new Error('栏舍已满');
                    // 巨大化幼崽不是独立品种：协议里 animal_id 仍是基础品种，
                    // 巨大幼崽本身走 giant_cub_item_id 单独指定。
                    const giant = input.source === 'bag' ? giantCubInfo(input.itemId) : null;
                    const animal = giant ? animalMap.get(String(giant.animalId)) : animalMap.get(String(input.itemId));
                    if (input.source === 'bag') {
                        if (!animal?.enable_flag || animal.husbandry_type !== ({ 1: '窝', 2: '棚' })[ranch.husbandryType]) throw new Error('幼崽不适合当前栏舍');
                        const count = state.items.filter(i => String(i.id) === String(input.itemId) && !i.locked).reduce((n, i) => n + BigInt(i.count || 0), 0n);
                        if (count <= 0n) throw new Error('背包幼崽不足');
                        reply = await mutate('PlaceAnimal', { items: [{ ranch_inst_id: id, animal_id: String(animal.id), ...(giant ? { giant_cub_item_id: String(giant.itemId) } : {}) }] });
                    } else {
                    const row = [...goodsMap.values()].find(g => g.shop_id === 5 && String(g.item_id) === String(input.itemId));
                    if (!animal?.enable_flag || animal.husbandry_type !== ({ 1: '窝', 2: '棚' })[ranch.husbandryType] || !row || row.price_id !== 1007) throw new Error('幼崽不适合当前栏舍或不支持金券购买');
                    const shop = await rpc('ShopInfo', { shop_id: 5 });
                    const goods = (shop.goods_list || []).find(g => String(g.id) === String(row.id));
                    if (!goods?.unlocked || goods.owned) throw new Error('幼崽未解锁或已下架');
                    if (BigInt(goods.limit_count || 0) > 0n && BigInt(goods.bought_num || 0) >= BigInt(goods.limit_count)) throw new Error('幼崽购买限额已用尽');
                    const second = now() / 1000;
                    if (Number(goods.discount_price) > 0 && second >= Number(goods.discount_start_time) && second < Number(goods.discount_end_time)) throw new Error('限时折扣价格语义待确认，暂不购买');
                    if (!/^[1-9]\d*$/.test(String(goods.price))) throw new Error('幼崽价格无效');
                    const balance = state.items.filter(i => String(i.id) === '1007' && !i.locked).reduce((n, i) => n + BigInt(i.count || 0), 0n);
                    if (balance < BigInt(goods.price)) throw new Error('金券不足');
                    if (automationKey && balance - BigInt(goods.price) < BigInt(normalizePolicy(getSettings().ranch_policy).goldReserve)) throw new Error('购买幼崽将低于金券保留量');
                    reply = await mutate('BuyGoods', { goods_id: String(row.id), num: '1', price: String(goods.price), auto_add: true });
                    }
                } else {
                    const animal = ranch.animals.find(a => String(a.animalInstId) === String(input.animalInstId));
                    if (!animal) throw new Error('动物已不存在或不属于当前栏舍');
                    const ref = { ranch_inst_id: id, animal_inst_id: animal.animalInstId };
                    if (input.action === 'produce') {
                        if (!animal.canTriggerProduce) throw new Error('动物当前不可生产');
                        reply = await mutate('TriggerProduce', { host_gid: String(getUserState().gid), targets: [ref] });
                    } else {
                        if (!animal.canHarvest) throw new Error('动物当前不可收获');
                        reply = await mutate('HarvestRanch', { ranch_inst_ids: [], op: 4, animals: [ref], shelves: [] });
                    }
                }
            }
            record(input.action, reply, trigger, input, { state: autoContext.state });
            // A refresh failure must not turn a completed mutation into a retryable failure.
            const status = await snapshot(false, !!automationKey);
            // 写操作会改背包/库存/货币：status 用这份最新快照直接喂面板缓存，其余分区作废，
            // 由下一次真实读回填——避免操作后面板拿到写之前的老数据。
            dropPanelExceptStatus();
            cachePanel('status', status);
            return { reply: describeResource(reply), status };
        })).catch(err => {
            // Expected races with other visitors: keep the failure semantics, but avoid
            // flooding automatic operation logs when there is simply nothing to do.
            const quietCode = { steal: '1045220', help: '1045233', putHazard: '1045230' }[input.action];
            if (trigger === 'automatic' && quietCode && new RegExp(`\\bcode=${quietCode}\\b`).test(err.message)) throw err;
            const detail = details(input);
            log('牧场', `${trigger === 'automatic' ? '自动' : '手动'}${ACTION_NAMES[input.action] || input.action}失败${detail.text ? `（${detail.text}）` : ''}：${err.message}`, { scene: 'ranch', module: ranchOperationModule(input.action), event: input.action, trigger, result: 'error', reason: err.message, ...detail.meta });
            throw err;
        });
    }
    const friendResourceCache = require('./local-friend-cache').createLocalFriendCache({
        key: 'ranch-resource', now, scope: () => process.env.FARM_ACCOUNT_ID ? `ranch-resource:${process.env.FARM_ACCOUNT_ID}:${getUserState().gid}` : '',
    });
    async function getResource(resource, forceRefresh = false) {
        if (resource === 'analytics') {
            const animals = config.MCAnimalConfig.filter(a => a.enable_flag).map(raw => {
                const animal = describeResource(raw);
                for (const key of ['productItem', 'byproductItem']) if (animal[key]) animal[key].name = itemMap.get(String(animal[key].id))?.name || `物品 ${animal[key].id}`;
                const cycleSeconds = Number(raw.infant_sec || 0) + Number(raw.grow_sec || 0) + Number(raw.mature_sec || 0);
                return { ...animal, cycleSeconds, harvestExpPerHour: cycleSeconds > 0 ? Number(raw.harvest_exp || 0) * 3600 / cycleSeconds : null };
            });
            return { animals, summary: { animalCount: animals.length }, assumptions: '依据官方基础配置；周期为幼崽、成长、成熟时长之和，未计生产等待、饲料中断、增益和变异，不代表实际收益。' };
        }
        if (resource === 'activity') return { activities: [], message: '暂无已登记的牧场限时活动' };
        let result;
        try {
            result = await exclusive(() => session.inRanch(async () => {
            if (resource === 'tasks') return { tasks: await readTasks() };
            if (resource === 'profile') {
                const user = getUserState();
                // Own profile must not depend on the cross-user BatchGetBasicInfo RPC.
                // Use the same cumulative ranch XP and official thresholds as upgrades.
                const bag = await rpc('GetBag', { global_scene_id: 2, tab_id: 0 });
                const items = [...(bag.physical_items || []), ...(bag.virtual_items || [])];
                const level = ranchLevel(items);
                if (level == null) throw new Error('服务端未返回有效的牧场经验');
                const exp = items.filter(i => String(i.id) === '1102').reduce((sum, i) => sum + BigInt(i.count), 0n);
                if (exp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('牧场经验超出安全计算范围');
                const levels = require('../gameConfig/BigFarmLevel.json');
                const current = levels.find(row => row.level === level);
                const next = levels.find(row => row.level === level + 1);
                return { name: user.name, avatar: user.avatar, level, exp: String(exp),
                    levelProgress: current && next ? { current: Math.max(0, Number(exp) - current.exp), needed: next.exp - current.exp } : null };
            }
            if (resource === 'friends') {
                return friendResourceCache.get(async () => {
                const all = await readFriends(forceRefresh);
                const reply = { friends: all.friends };
                let visitors = []; let visitorsError = null;
                try { visitors = describeResource((await rpc('InteractRecords', { global_scene_id: 2 })).records || []); }
                catch (err) { visitorsError = err.message; }
                return { ...camelize(reply), visitors, visitorsError, blockedPlayers: camelize(all.blocked_players || []), capabilities: CAPABILITIES };
                }, forceRefresh);
            }
            if (resource === 'shop') {
                const errors = {};
                const shops = [];
                let profiles = [];
                try { profiles = (await rpc('ShopProfiles', { global_scene_id: 2 })).shop_profiles || []; }
                catch (err) { errors.profiles = err.message; }
                for (const shopId of [5, 6]) {
                    const name = profiles.find(p => String(p.shop_id) === String(shopId))?.shop_name || shopConfig.MCShop.find(p => p.id === shopId)?.type || `牧场商店 ${shopId}`;
                    try { const data = describeResource(await rpc('ShopInfo', { shop_id: shopId }));
                        data.goodsList = (data.goodsList || []).map(g => { const row = goodsMap.get(String(g.id)); const itemId = g.itemId ?? row?.item_id; return { ...g, itemId, name: itemMap.get(String(itemId))?.name || g.name, image: ranchItemImage(itemId), itemCount: g.itemCount ?? row?.item_count, priceId: row?.price_id, currencyName: itemMap.get(String(row?.price_id))?.name, maxQuantity: row?.one_buy_count || 99 }; });
                        shops.push({ shopId, name, ...data }); }
                    catch (err) { shops.push({ shopId, name, error: err.message, goodsList: [] }); }
                }
                let exchangeMarket;
                try { exchangeMarket = { shopId: 7, ...describeResource(await rpc('RotationShopInfo', { shop_id: 7 })) };
                    exchangeMarket.goods = (exchangeMarket.goods || []).map(g => ({ ...g, effectiveCostCount: Number(g.discountPrice) > 0 && now() / 1000 >= Number(g.discountStartTime) && now() / 1000 < Number(g.discountEndTime) ? g.discountPrice : g.costCount })); }
                catch (err) { errors.exchange = err.message; }
                let balance = null;
                let resources = SHOP_RESOURCE_IDS.map(id => ({ id, name: itemMap.get(String(id))?.name, image: ranchItemImage(id), count: null }));
                try {
                    const bag = await rpc('GetBag', { global_scene_id: 2, tab_id: 0 });
                    const items = [...(bag.physical_items || []), ...(bag.virtual_items || [])];
                    resources = resources.map(resource => ({ ...resource, count: items.filter(i => String(i.id) === String(resource.id) && !i.locked && !i.is_locked).reduce((n, i) => n + BigInt(i.count || 0), 0n).toString() }));
                    balance = resources.find(r => r.id === 1007).count;
                } catch (err) { errors.balance = err.message; }
                // 每日免费礼包（罐头商城 slot 6/7，is_free + 零价）：单独一栏，未领取时前端可直接领。
                let freeGifts = [];
                try {
                    freeGifts = (await listFreeGifts()).gifts.map(entry => ({
                        slotType: entry.slotType,
                        goodsId: String(entry.good.goods_id),
                        name: itemMap.get(String(entry.good.reward_items?.[0]?.id))?.name || entry.good.name,
                        image: ranchItemImage(entry.good.reward_items?.[0]?.id),
                        rewards: (entry.good.reward_items || []).map(row => ({ ...row, name: itemMap.get(String(row.id))?.name })),
                    }));
                } catch { /* 礼包区为可选项，读取失败不影响商品与余额 */ }
                return { shops, exchangeMarket, freeGifts, errors, balance, resources, capabilities: CAPABILITIES };
            }
            if (resource === 'illustrated') {
                const list = await rpc('GetIllustratedListV2', { rarity: 0, type: 101 });
                const errors = {};
                let levels, weightScore;
                try { levels = await rpc('GetIllustratedLevelListV2', { type: 101 }); } catch (err) { errors.levels = err.message; }
                try { weightScore = await rpc('GetRanchWeightScoreV2', {}); } catch (err) { errors.weight = err.message; }
                // 巨大化个体按档位配置补 tier_name（匀称/超重/极重/巨无霸），与官方界面一致
                if (Array.isArray(list.list)) {
                    // 图鉴按官方收录等级排序（Illustrated.json param->sort），服务器原始顺序是乱的
                    list.list.sort((a, b) => illustratedSortKey(a.fruit_id ?? a.fruitId) - illustratedSortKey(b.fruit_id ?? b.fruitId));
                    for (const entry of list.list) {
                        if (entry && entry.giant && entry.giant.tier != null)
                            entry.giant.tier_name = weightTierMap.get(Number(entry.giant.tier))?.tier_name || '';
                    }
                }
                return { ...describeResource(list), levels: describeResource(levels), weightScore: describeResource(weightScore), errors, capabilities: CAPABILITIES };
            }
            throw new Error('未知牧场功能');
        }));
        // 读失败（队列超时 / 场景退避 / 上游限频）时退回上次成功快照：好友页、商城页至少还能看，
        // 不会因为一次慢请求就整屏空白。stale 标记留给前端提示。
        } catch (err) {
            const stale = stalePanel(resource);
            if (stale) return { ...stale, stale: true, staleError: err.message };
            throw err;
        }
        // 全失败/空的商城面板不进缓存，否则 30 分钟 TTL 内用户会一直看到空商店。
        if (!(resource === 'shop' && !(Array.isArray(result?.shops) && result.shops.some(shop => !shop.error)))) {
            cachePanel(resource, result);
        }
        return result;
    }
    // 商城目录（商品、价格、限购）是官方静态配置，基本不变；心跳里预热一次，
    // 打开商城时 worker 直接命中 peekPanel，不进场景、不排队。
    let shopWarmAt = 0;
    // 心跳首次触发的时间点（错峰，防多账号同时打 CheckCanShare / ShopInfo 触发限频）
    let dailyClaimsNotBefore = 0;
    let shopWarmNotBefore = 0;
    async function warmShopCache() {
        if (peekPanel('shop') || now() - shopWarmAt < 10 * 60 * 1000) return;
        if (!getUserState().gid || operation || automationRunning) return;
        const level = Number(getUserState().level);
        if (Number.isFinite(level) && level < 25) return;
        if (session.snapshot?.().blockedScenes?.includes('ranch')) return;
        shopWarmAt = now();
        try { await getResource('shop'); }
        catch (err) { log('牧场', `预热商城目录失败：${err.message}`, { scene: 'ranch', module: ranchOperationModule('buy'), event: 'warmShop', result: 'error' }); }
    }
    return { connect, disconnect, action, getResource,
        getStatus,
        peekPanel,
        getAutomationSchedule() { return scheduler.status(scheduledSettings(), normalizePolicy(getSettings().ranch_policy)); },
        async tickAutomation(options = {}) {
            if (planEpoch !== session.getEpoch?.()) { maturityPlan.reset(); continuations.clear(); scheduler.reset(); planEpoch = session.getEpoch?.(); }
            const status = await scheduler.tick({ settings: scheduledSettings, stealDelay: () => maturityPlan.nextDelay({ autoSteal: true }), policy: () => normalizePolicy(getSettings().ranch_policy),
                ready: () => !!getUserState().gid && !operation && !automationRunning && !session.snapshot?.().blockedScenes?.includes('ranch'),
                run: group => this.runAutomation(group, { deadlineAt: options.deadlineAt }) });
            // 每日分享/免费礼包：与农场一致默认执行，不受任何开关控制。
            // 心跳里（background）不能 await：领奖要串 CheckCanShare / 商城列表 / Purchase，
            // 挂在这里会让后续每次 tick 都在等同一串 RPC。直接调用时保持串行以便测试和手动触发可观测。
            if (options.background) {
                // 多账号同进程几乎同时登录，ShareService 有限频保护（1020002 网络繁忙）。
                // 首次执行错峰到 5~95 秒里的随机点，之后由 10 分钟退避接管。
                if (!dailyClaimsNotBefore) dailyClaimsNotBefore = now() + 5000 + Math.floor(Math.random() * 90000);
                if (now() >= dailyClaimsNotBefore) runDailyClaims().catch(() => {});
            } else await runDailyClaims();
            // 商城目录预热只属于后台心跳：一次要串 6~7 个 RPC（两个 ShopInfo + 轮换商店 + 背包 + 免费礼包），
            // await 会把后续每次 tick 都堵住；同步调用（测试/手动）也不该顺带预热，否则会打乱 automation 的节拍。
            if (options.background) {
                if (!shopWarmNotBefore) shopWarmNotBefore = now() + 10000 + Math.floor(Math.random() * 110000);
                if (now() >= shopWarmNotBefore) warmShopCache().catch(() => {});
            }
            return status;
        },
        async runAutomation(group = 'all', { deadlineAt } = {}) {
            const quotaExtra = {};
            return session.inRanch(async () => {
                const runSettings = () => Object.fromEntries(Object.entries(settings()).filter(([key]) => !ALWAYS_ON[key]).map(([key, value]) => [key, value && inGroup(key, group)]));
                if (!getUserState().gid || operation || automationRunning) return { status: 'deferred' };
                if (planEpoch !== session.getEpoch?.()) { maturityPlan.reset(); continuations.clear(); planEpoch = session.getEpoch?.(); }
                const p = normalizePolicy(getSettings().ranch_policy);
                const opts = runSettings();
                if (!Object.values(opts).some(Boolean)) { continuations.delete(group); return { status: 'completed' }; }
                const automationEpoch = session.getEpoch?.();
                const signature = JSON.stringify([opts, p]);
                let progress = continuations.get(group);
                if (!progress || progress.signature !== signature) {
                    progress = { signature, done: new Set() };
                    continuations.set(group, progress);
                }
                let advanced = false, yielded = false, actionCount = 0, deadlineYield = false;
                // 时间切片：单次进场景的自动化最长跑 SLICE_MS（默认 15 秒），到点让路，
                // 调度器立即续跑（continuation 保留进度），避免一次长驻留拖住农场巡访。
                const sliceMs = Math.max(3000, Number(process.env.RANCH_SLICE_MS) || 15000);
                const sliceStartedAt = now();
                const identity = (payload, key = ACTION_SWITCH[payload.action]) => {
                    const { count, price, costCount, costs, ...target } = payload;
                    // place 必须能反复执行：同一栏位同一品种在配置不变时只会被放一次，
                    // 栏位就永远填不满。带上当前栏位数量让身份随进度变化，
                    // 同时仍保留「同一次数量下不重复写」的防重放语义。
                    if (payload.action === 'place') {
                        return JSON.stringify([key, target, Number(payload.placeSeq) || 0]);
                    }
                    return JSON.stringify([key, target]);
                };
                // Always allow one new complete action per slice. Slow prerequisite reads must
                // not make the same tail action yield forever before it can make progress.
                const alive = () => {
                    // An invalid lease must end this slice, not visit every remaining
                    // friend and repeatedly report cancellation from the same failure.
                    try { session.assertAllowed(); } catch { return false; }
                    if (!getUserState().gid || automationEpoch !== session.getEpoch?.()) return false;
                    // farmDeadline 死线：农场/好友巡访的下次到期时刻之前必须离开场景，
                    // 让统一 tick 准点接管（对齐 liyangpengs 版的 farmDeadline 模型）。
                    const deadline = Number(typeof deadlineAt === 'function' ? deadlineAt() : deadlineAt);
                    if (Number.isFinite(deadline) && deadline > 0 && now() >= deadline) { yielded = true; deadlineYield = true; return false; }
                    if (advanced && now() - sliceStartedAt >= sliceMs) { yielded = true; return false; }
                    if (actionCount >= p.maxActionsPerRun || (advanced && session.shouldYield?.())) { yielded = true; return false; }
                    return true;
                };
                automationRunning = true;
                lastAutomationAt = now();
                let cachedState, cachedBook;
                const readState = async () => cachedState || (cachedState = await snapshot(false, true));
                try {
                    const attempt = async (payload, key = ACTION_SWITCH[payload.action]) => {
                        const id = identity(payload, key);
                        if (progress.done.has(id) || !alive()) return;
                        // Mark before sending, including uncertain failures: never replay a write
                        // merely because a slice yielded. The action still performs live validation.
                        progress.done.add(id); advanced = true; actionCount++;
                        cachedState = null; cachedBook = null;
                        try {
                            const result = await action(payload, key);
                            if (result?.status) cachedState = result.status;
                            return result;
                        } catch { /* action logs its own failure; continue independent tasks */ }
                    };
                    const automationService = {
                        action: (...args) => this.action(...args),
                        withFriendVisit,
                        getStatus: readState,
                        getResource: async resource => resource === 'illustrated'
                            ? cachedBook || (cachedBook = await this.getResource(resource)) : this.getResource(resource),
                    };
                    const state = group === 'farm' || group === 'all' ? await readState() : { ranches: [], orders: [] };
                    for (const ranch of state.ranches || []) {
                        if (!alive()) break;
                        // Re-read switches before each action; yielding occurs only between complete actions.
                        if (runSettings().autoCollect && ranch.shelves.some(s => s.canCollect)) await attempt({ action: 'collect', ranchId: ranch.ranchInstId });
                        if (runSettings().autoClean && ranch.hazards.length) await attempt({ action: 'clean', ranchId: ranch.ranchInstId });
                        for (const animal of ranch.animals) {
                            if (runSettings().autoProduce && animal.canTriggerProduce && getUserState().gid) await attempt({ action: 'produce', ranchId: ranch.ranchInstId, animalInstId: animal.animalInstId });
                            if (runSettings().autoHarvest && animal.canHarvest && getUserState().gid) await attempt({ action: 'harvest', ranchId: ranch.ranchInstId, animalInstId: animal.animalInstId });
                        }
                    }
                    if (runSettings().autoSubmitOrders) {
                        for (const order of state.orders || []) {
                            if (!alive() || !runSettings().autoSubmitOrders) break;
                            if (order.canSubmit) await attempt({ action: 'submitOrder', slotIndex: order.slotIndex, instanceId: order.instanceId });
                        }
                    }
                    if (alive() && runSettings().autoClaimTasks) {
                        try {
                            // 先把客户端上报类成长任务补满（打开好友面板等），否则它们永远不会变成可领取。
                            const reported = await reportClientReportedTasks();
                            if (reported.length) {
                                log('牧场', `成长任务进度已上报 ${reported.length} 项：${reported.map(r => r.desc || r.id).join('、')}`, {
                                    scene: 'ranch', module: ranchOperationModule('claimTask'), event: 'reportTask', result: reported.every(r => r.ok) ? 'ok' : 'ignored',
                                });
                            }
                        } catch (err) { log('牧场', `成长任务进度上报失败：${err.message}`, { scene: 'ranch', module: ranchOperationModule('claimTask'), event: 'reportTask', result: 'error' }); }
                        try {
                            // Re-read after each claim so newly unlocked growth stages can proceed.
                            // Each ID is attempted once per pass, including uncertain write failures.
                            while (alive() && runSettings().autoClaimTasks) {
                                const tasks = (await automationService.getResource('tasks')).tasks;
                                const task = tasks.find(t => [4, 5].includes(Number(t.taskType)) && t.isUnlocked && !t.isClaimed &&
                                    BigInt(t.totalProgress || 0) > 0n && BigInt(t.progress || 0) >= BigInt(t.totalProgress) &&
                                    !progress.done.has(identity({ action: 'claimTask', taskId: String(t.id) })));
                                if (!task) break;
                                await attempt({ action: 'claimTask', taskId: String(task.id) });
                            }
                        } catch (err) { log('牧场', `自动任务领奖查询失败：${err.message}`, { scene: 'ranch', module: ranchOperationModule('claimTask'), event: 'claimTask', result: 'error' }); }
                    }
                    if (alive() && runSettings().autoClaimIllustrated) {
                        try { const book = await automationService.getResource('illustrated'); if (book.hasClaimableReward && runSettings().autoClaimIllustrated) await attempt({ action: 'claimIllustrated' }); }
                        catch (err) { log('牧场', `自动图鉴查询失败：${err.message}`, { scene: 'ranch', module: ranchOperationModule('claimIllustrated'), event: 'claimIllustrated', result: 'error' }); }
                    }
                    if (alive() && runSettings().autoClaimWeight) {
                        try {
                            const book = await automationService.getResource('illustrated');
                            for (const level of book.weightScore?.levels || []) {
                                if (!alive() || !runSettings().autoClaimWeight) break;
                                if (level.canClaim && !level.claimed) await attempt({ action: 'claimWeight', id: level.id });
                            }
                        } catch (err) { log('牧场', `自动重量积分查询失败：${err.message}`, { scene: 'ranch', module: ranchOperationModule('claimWeight'), event: 'claimWeight', result: 'error' }); }
                    }
                    await runRanchExtraAutomation({
                        service: automationService, attempt, continuation: progress, hasCompleted: (payload, key) => progress.done.has(identity(payload, key)), onLimit: () => { yielded = true; }, settings: runSettings, policy: () => normalizePolicy(getSettings().ranch_policy),
                        alive, goodsMap,
                        getCursor: () => friendCursors[group], setCursor: value => { friendCursors[group] = value; },
                        now, serverNow, maturityPlan: group === 'steal' || (group === 'all' && p.mode === 'simple') ? maturityPlan : null,
                        extra: quotaExtra,
                        friendRanchStatus: prefetchFriendRanchStatus,
                        logError: err => log('牧场', `自动任务查询失败：${err.message}`, { scene: 'ranch', module: 'ranch', event: 'automation', trigger: 'automatic', result: 'error' }),
                        logEvent: (message, meta = {}) => log('牧场', message, { scene: 'ranch', module: 'friend', trigger: 'automatic', ...meta }),
                    });
                    if (!getUserState().gid || automationEpoch !== session.getEpoch?.()) {
                        continuations.delete(group);
                        return { cancelled: true };
                    }
                    if (!yielded) continuations.delete(group);
                    // 自动化本来就在牧场驻留并读了一份快照，顺手喂给面板缓存：概览页在两次
                    // 真实读之间也能秒回，且不产生任何额外场景请求。快照缺 tasks 时补一次读
                    // （一次 RPC），让 status 面板的任务区不空窗。
                    if (cachedState) {
                        if (!cachedState.tasks) { try { cachedState.tasks = await readTasks(); } catch { /* 缺任务区可接受 */ } }
                        cachePanel('status', cachedState);
                    }
                    const clock = serverNow();
                    const latest = cachedState || state;
                    const deadlines = [
                        ...(latest.ranches || []).flatMap(r => (r.animals || []).flatMap(a => [a.infantReadyAtMs, a.growReadyAtMs, a.produceReadyAtMs, a.matureReadyAtMs])),
                        ...(latest.facilities || []).filter(f => f.upgradeState).map(f => Number(f.upgradeEndTime) * 1000),
                    ].map(Number).filter(at => Number.isFinite(at) && at > clock);
                    // 死线让路时推迟重入：给农场/好友巡访留 2 秒接管窗口，避免牧场下一秒
                    // 又把场景抢回去。配额排班（北京 0 点）由调度器取 max 应用到队列。
                    const retryAfterMs = deadlineYield ? Math.max(1000, Number(deadlineAt()) + 2000 - now()) : undefined;
                    return { status: yielded ? 'yielded' : 'completed', nextAt: deadlines.length ? now() + Math.max(1000, Math.min(...deadlines) - clock) : undefined,
                        retryAfterMs, quotaResetAtMs: Number(quotaExtra.quotaResetAtMs) || undefined };
                } finally {
                    automationRunning = false;
                }
            }, { key: `automation:${group}` }).catch(err => {
                if (err.code === 'SCENE_CANCELLED') return { cancelled: true };
                throw err;
            });
        },
        flushOperationsSave,
    };
}
let singleton;
function getRanchService() {
    if (!singleton) {
        const { sendMsgAsync, getUserState } = require('../utils/network');
        const protocol = createRanchProtocol();
        singleton = createRanchService({ getUserState, serverNow: () => require('../utils/utils').getServerTimeSec() * 1000,
            getSettings: () => require('../models/store').getAutomation(),
            log: require('../utils/utils').log,
            rpc: async (method, params) => {
                const def = protocol.rpc[method];
                const { body } = await sendMsgAsync(def.service, method, protocol.encode(method, params));
                return protocol.decode(method, body);
            },
        });
    }
    return singleton;
}
module.exports = { createRanchService, getRanchService, normalizeSnapshot, normalizeSettings, SETTINGS_KEYS, CAPABILITIES };
