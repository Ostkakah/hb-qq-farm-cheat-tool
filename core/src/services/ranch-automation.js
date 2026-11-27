const { ACTION_SWITCH } = require('./ranch-settings');
const { selectCub, feedTypes, quietNow, purchasableCubs, giantCubInfo } = require('./ranch-strategy');
const CONFIG = require('../gameConfig/RanchConfig.json');
const stock = (items, id, usable = false) => (items || []).filter(i => String(i.id) === String(id) && (!usable || (!i.locked && !i.is_locked && !i.isLocked && !i.detail?.ranchProduct && !i.item_detail?.ranch_product))).reduce((n, i) => n + BigInt(i.count || 0), 0n);
const cap = (...values) => Number(values.map(BigInt).reduce((a, b) => a < b ? a : b));
const canConfig = new Map(CONFIG.MCCanConfig.map(c => [String(c.id), c]));
const bucketId = can => can.feed_type === '有机罐头' ? '7004' : '7003';
// 牧草阈值：按容量百分比触发，触发后补满到容量；0 表示关闭阈值、沿用老的绝对目标数。
const FEED_ITEM_ID = '7001';
// 好友牧草机金券补满：与 ranch.js 同源，抓包实测 60 金券（1007）/ 单位。
const GOLD_ITEM_ID = '1007';
const FEED_GOLD_UNIT_COST = 60n;
const feedThresholdCount = (capacity, percent) => Math.max(1, Math.ceil(Number(capacity) * Number(percent) / 100));
const feedFillTarget = (capacity, feedCount, p) => {
    const total = Number(capacity);
    if (!(total > 0)) return 0;
    if (p.feedThresholdPercent > 0) return Number(feedCount) < feedThresholdCount(total, p.feedThresholdPercent) ? total : 0;
    return Math.min(total, p.feedTargetCount);
};
function assertAutomationPolicy(input, p, { state, market, exchangeEnabled = false, simpleExchange = false } = {}) {
    const reject = () => { throw new Error('牧场自动策略已变化或超过库存/保留量/价格限制'); };
    if (input.action === 'friendFeed') {
        // 只给白名单里的好友加牧草；白名单为空时该自动化不执行任何动作。
        if (!p.feedFriendGids.includes(String(input.hostGid))) reject();
        // 金券补满必须显式开启，避免策略变更后替账号偷偷花货币。
        if (input.useGold === true && p.feedFriendUseGold !== true) reject();
    } else if (['steal', 'friendProduce', 'help', 'stroke', 'putHazard'].includes(input.action)) {
        const host = String(input.hostGid);
        if (p.friendExcludeGids.includes(host) || (p.friendIncludeGids.length && !p.friendIncludeGids.includes(host))) reject();
    } else if (input.action === 'sell') {
        // Inventory and lock validation is shared with manual sales. Historical
        // mode/whitelist/reserve/quantity policies do not constrain auto selling.
    } else if (input.action === 'useCan') {
        const can = canConfig.get(String(input.itemId));
        if (!can || !p.canItemIds.includes(String(input.itemId)) || input.count > p.canMaxPerRun || stock(state.items, input.itemId, true) - BigInt(input.count) < BigInt(p.canReserveCount) || stock(state.items, bucketId(can)) + BigInt(input.count * can.speed_up_secs) > BigInt(p.bucketTargetSeconds)) reject();
    } else if (input.action === 'addFeed') {
        // 金券兜底：必须显式开启（与 feedFriendUseGold 同样的防误花设计）；余额/保留量由 action 实时校验。
        if (input.useGold === true) {
            if (p.addFeedUseGold !== true) reject();
            return;
        }
        const machine = state.facilities.find(f => String(f.instId) === String(input.facilityInstId));
        const ceiling = p.feedThresholdPercent > 0 ? Number(machine?.capacity ?? 0) : p.feedTargetCount;
        if (!machine?.feedMachine || !(ceiling > 0) || Number(machine.feedMachine.feedCount) + input.count > ceiling || stock(state.items, FEED_ITEM_ID, true) - BigInt(input.count) < BigInt(p.feedReserveCount)) reject();
    } else if (input.action === 'place') {
        // 巨大化幼崽按基础品种核对白名单（白名单里存的是普通幼崽 id）
        const giant = giantCubInfo(input.itemId);
        const whitelistId = giant ? giant.baseItemId : String(input.itemId);
        if (!p.cubItemIds.includes(whitelistId)) reject();
    } else if (input.action === 'buy' || input.action === 'exchange') {
        if (input.action === 'exchange' && simpleExchange) {
            if (!market || !['7002', '1008'].includes(market.costItemId) || market.price <= 0n || market.balance < market.price * BigInt(input.count)) reject();
            return;
        }
        const rule = p[input.action === 'buy' ? 'buyRules' : 'exchangeRules'].find(r => r.goodsId === String(input.goodsId));
        if (!rule || !market || input.count > rule.maxPerRun || market.price > BigInt(rule.maxUnitPrice)) reject();
        if (input.action === 'exchange' && (rule.itemId !== market.itemId || rule.costItemId !== market.costItemId)) reject();
        const reserve = market.costItemId === '1007' ? p.goldReserve : market.costItemId === '7002' ? p.poopReserve : market.costItemId === '1008' ? p.pineReserve : null;
        if (reserve === null || market.balance - market.price * BigInt(input.count) < BigInt(reserve)) reject();
        const items = [...(market.bag.physical_items || []), ...(market.bag.virtual_items || [])];
        if (!(market.itemCount > 0) || stock(items, market.itemId) + BigInt(input.count * market.itemCount) > BigInt(rule.targetStock)) reject();
    }
}
async function runRanchExtraAutomation(ctx) {
    const { service, attempt, settings, policy, alive: isAlive, goodsMap, getCursor, setCursor, logError } = ctx;
    let used = 0, cancelled = false;
    const alive = () => !cancelled && isAlive();
    const enabled = key => {
        if (settings()[key] && used >= policy().maxActionsPerRun) ctx.onLimit?.();
        return alive() && settings()[key] && used < policy().maxActionsPerRun;
    };
    const perform = async (input, key = ACTION_SWITCH[input.action]) => {
        if (ctx.hasCompleted?.(input, key) || !enabled(key)) return;
        used++;
        return attempt(input, key);
    };
    const safely = async fn => {
        if (!alive()) return;
        try { await fn(); } catch (err) {
            if (['REQUEST_TIMEOUT', 'ENCODE_TIMEOUT', 'CONNECTION_CLOSED', 'SCENE_CANCELLED'].includes(err.code)) cancelled = true;
            logError(err);
        }
    };
    if (enabled('autoAddFeed')) await safely(async () => {
        const facilities = (await service.getStatus()).facilities;
        let goldBudget = null;
        for (const original of facilities.filter(f => f.feedMachine)) {
            if (!enabled('autoAddFeed')) break;
            const state = await service.getStatus(); const p = policy();
            const facility = state.facilities.find(f => String(f.instId) === String(original.instId));
            if (!facility?.feedMachine) continue;
            const target = feedFillTarget(facility.capacity, facility.feedMachine.feedCount, p);
            let gap = target > 0 ? target - Number(facility.feedMachine.feedCount) : 0;
            if (!(gap > 0)) continue;
            // 仓库牧草优先消耗（保留 feedReserveCount）；不足时若开启金券兜底，把剩余缺口按 60 金券/单位补满。
            const surplus = stock(state.items, FEED_ITEM_ID, true) - BigInt(p.feedReserveCount);
            if (surplus > 0n) {
                const count = cap(gap, surplus, 2147483647);
                if (count > 0 && await perform({ action: 'addFeed', facilityInstId: facility.instId, count })) gap -= count;
            }
            if (!(gap > 0) || p.addFeedUseGold !== true) continue;
            if (goldBudget == null) {
                const fresh = await service.getStatus();
                if (fresh.sectionErrors?.warehouse) continue;
                goldBudget = stock(fresh.items, GOLD_ITEM_ID, true) - BigInt(p.goldReserve);
            }
            const cost = BigInt(gap) * FEED_GOLD_UNIT_COST;
            if (goldBudget < cost) continue;
            if (await perform({ action: 'addFeed', facilityInstId: facility.instId, useGold: true })) goldBudget -= cost;
        }
    });
    // Currency opt-ins follow the current market; never use gold/diamonds or stale rounds.
    if (enabled('autoExchangePoop') || enabled('autoExchangePine')) await safely(async () => {
        const initial = (await service.getResource('shop')).exchangeMarket;
        if (!initial?.opened || !initial.present) return;
        for (const original of initial.goods || []) await safely(async () => {
            const key = String(original.costItemId) === '7002' ? 'autoExchangePoop' : String(original.costItemId) === '1008' ? 'autoExchangePine' : null;
            if (!key || !enabled(key)) return;
            const market = (await service.getResource('shop')).exchangeMarket;
            if (!market?.opened || !market.present) return;
            const goods = market.goods?.find(g => String(g.goodsId) === String(original.goodsId) && String(g.costItemId) === String(original.costItemId) && String(g.itemId) === String(original.itemId));
            if (!goods) return;
            const state = await service.getStatus();
            if (state.sectionErrors?.warehouse) return;
            const price = BigInt(goods.effectiveCostCount || 0);
            const available = BigInt(goods.limitCount || 0) > 0n ? BigInt(goods.limitCount) - BigInt(goods.limitUsed || goods.boughtNum || 0) : 99n;
            // Each request remains capped; the live action rechecks currency, stock and round.
            if (price <= 0n || available <= 0n) return;
            const count = cap(99, available, stock(state.items, goods.costItemId, true) / price);
            if (count > 0) await perform({ action: 'exchange', goodsId: String(goods.goodsId), count, costCount: String(price), costItemId: String(goods.costItemId), periodDay: market.periodDay, roundIndex: market.roundIndex }, key);
        });
    });
    // Buy/exchange to target stock first; later inventory tasks can use newly acquired supplies.
    for (const mode of ['buy', 'exchange']) {
        const key = mode === 'buy' ? 'autoBuy' : 'autoExchange';
        for (const originalRule of policy()[mode === 'buy' ? 'buyRules' : 'exchangeRules']) await safely(async () => {
            if (!enabled(key)) return;
            const p = policy();
            const rule = p[mode === 'buy' ? 'buyRules' : 'exchangeRules'].find(r => r.goodsId === originalRule.goodsId);
            if (!rule) return;
            const shop = await service.getResource('shop');
            const state = await service.getStatus();
            if (state.sectionErrors?.warehouse) return;
            let goods, itemId, itemCount, price, balance, reserve, maxCount;
            let payload;
            if (mode === 'buy') {
                const row = goodsMap.get(rule.goodsId);
                if (!row || ![5, 6].includes(row.shop_id) || row.price_id !== 1007) return;
                goods = shop.shops.find(s => s.shopId === row.shop_id)?.goodsList?.find(g => String(g.id) === rule.goodsId);
                if (!goods?.unlocked || goods.owned) return;
                itemId = String(row.item_id); itemCount = Number(row.item_count); price = BigInt(goods.price || 0);
                balance = stock(state.items, '1007', true); reserve = p.goldReserve; maxCount = row.one_buy_count || 99;
                payload = { action: mode, goodsId: rule.goodsId, price: String(price) };
            } else {
                const market = shop.exchangeMarket;
                if (!market?.opened || !market.present) return;
                goods = market.goods?.find(g => String(g.goodsId) === rule.goodsId);
                if (!goods || !['7002', '1008'].includes(String(goods.costItemId)) || rule.itemId !== String(goods.itemId) || rule.costItemId !== String(goods.costItemId)) return;
                itemId = String(goods.itemId); itemCount = Number(goods.itemCount); price = BigInt(goods.effectiveCostCount || 0);
                balance = stock(state.items, goods.costItemId, true); reserve = goods.costItemId === '7002' ? p.poopReserve : p.pineReserve; maxCount = 99;
                payload = { action: mode, goodsId: rule.goodsId, costCount: String(price), costItemId: String(goods.costItemId), periodDay: market.periodDay, roundIndex: market.roundIndex };
            }
            if (!(itemCount > 0) || price <= 0n || price > BigInt(rule.maxUnitPrice) || balance <= BigInt(reserve)) return;
            const gap = BigInt(rule.targetStock) - stock(state.items, itemId);
            if (gap < BigInt(itemCount)) return;
            const limitCount = BigInt(goods.limitCount || 0);
            const available = limitCount > 0n ? limitCount - BigInt(goods.boughtNum || goods.limitUsed || 0) : 99999n;
            if (available <= 0n) return;
            const count = cap(rule.maxPerRun, maxCount, gap / BigInt(itemCount), (balance - BigInt(reserve)) / price, available);
            if (count > 0) await perform({ ...payload, count });
        });
    }
    if (enabled('autoSell')) await safely(async () => {
        const state = await service.getStatus();
        const items = state.items.filter(item => item.canSell && BigInt(item.count || 0) > 0n)
            .map(item => ({ itemId: String(item.id), uid: item.uid || '0', count: Number(item.count) }));
        if (items.length) await perform({ action: 'sell', items });
    });
    if (enabled('autoUseCan')) for (const id of policy().canItemIds) await safely(async () => {
        if (!enabled('autoUseCan')) return;
        const can = canConfig.get(id);
        if (!can) return;
        const state = await service.getStatus(); const p = policy();
        const item = state.items.find(i => String(i.id) === id && i.canUseCan && !i.locked);
        const surplus = stock(state.items, id, true) - BigInt(p.canReserveCount);
        const gap = BigInt(p.bucketTargetSeconds) - stock(state.items, bucketId(can));
        if (!item || surplus <= 0n || gap < BigInt(can.speed_up_secs)) return;
        const count = cap(item.count, surplus, gap / BigInt(can.speed_up_secs), p.canMaxPerRun);
        if (count > 0) await perform({ action: 'useCan', itemId: id, uid: item.uid || '0', count });
    });
    if (enabled('autoPlace')) await safely(async () => {
        const ranches = (await service.getStatus()).ranches;
        for (const original of ranches) {
            if (!enabled('autoPlace')) break;
            const state = await service.getStatus();
            const ranch = state.ranches.find(r => String(r.ranchInstId) === String(original.ranchInstId));
            if (!ranch || Number(ranch.animalCount) >= Number(ranch.capacity)) continue;
            const p = policy();
            const bagPriority = p.mode === 'simple' && p.husbandryStrategy === 'bag_priority';
            const inventory = (ranch.availableCubs || []).filter(c => BigInt(c.count || 0) > 0n);
            const useBag = bagPriority && inventory.length > 0;
            const strategy = bagPriority ? p.husbandryFallbackStrategy : p.husbandryStrategy;
            const allowed = new Set(p.cubItemIds.map(String));

            // 空位优先放牧背包里的巨大化幼崽：巨大化个体是图鉴「巨大化个体」的唯一来源，
            // 商店买不到、放一只少一只，所以先占住空位；没有合适的巨大幼崽再走原策略
            // （背包普通幼崽 / 商店购买）。品种仍受 cubItemIds 白名单约束。
            const giantCubs = inventory.filter(c => c.giant && allowed.has(String(c.baseItemId)));
            if (giantCubs.length) {
                const giant = [...giantCubs]
                    .sort((a, b) => Number(b.level || 0) - Number(a.level || 0) || Number(a.itemId) - Number(b.itemId))[0];
                await perform({ action: 'place', ranchId: ranch.ranchInstId, itemId: giant.itemId, source: 'bag', placeSeq: Number(ranch.animalCount) || 0 });
                continue;
            }

            if (p.mode === 'simple') {
                // simple 模式语义不变：优先从商店买（BuyGoods auto_add），仓库优先时才用背包。
                const shop = !useBag ? await service.getResource('shop') : null;
                const candidates = useBag ? inventory : shop ? purchasableCubs(ranch, shop, goodsMap) : inventory;
                const cub = selectCub(candidates, useBag ? 'level' : strategy, !useBag && strategy === 'task' ? (await service.getResource('tasks')).tasks : []);
                if (cub) await perform({ action: 'place', ranchId: ranch.ranchInstId, itemId: cub.itemId, ...(useBag ? { source: 'bag' } : {}) });
                continue;
            }
            // legacy 模式：cubItemIds 是「允许养哪些品种」的白名单，
            // 具体养哪一档由代码按「当前牧场等级养得起的最高级」决定 ———
            // 否则白名单里排最前的低等级动物会一直占着栏位（例：Lv3 的鸭）。
            // placeSeq 参与动作去重身份：栏位数量每次都在变，否则同一栏位同一品种
            // 只会被放一次，栏位永远填不满。
            const shop = await service.getResource('shop');
            const purchasable = purchasableCubs(ranch, shop, goodsMap);
            // 白名单是「允许养哪些品种」；在白名单里挑当前牧场等级养得起的最高级那档。
            // 白名单为空 → 这一轮不放（place 的策略校验同样要求 itemId 在白名单里）。
            const pool = purchasable.filter(c => allowed.has(String(c.itemId)));
            const cub = [...pool]
                .sort((a, b) => Number(b.requiredLevel || 0) - Number(a.requiredLevel || 0))[0];
            if (cub) await perform({ action: 'place', ranchId: ranch.ranchInstId, itemId: cub.itemId, placeSeq: Number(ranch.animalCount) || 0 });
        }
    });
    if (enabled('autoFeedAnimal')) await safely(async () => {
        const state = await service.getStatus();
        for (const ranch of state.ranches) for (const animal of ranch.animals) {
            for (const bucketType of feedTypes(animal, policy(), (ctx.now || Date.now)())) {
                if (!enabled('autoFeedAnimal')) break;
                if (stock(state.items, bucketType === 1 ? '7004' : '7003', true) > 0n) await perform({ action: 'feedAnimal', ranchId: ranch.ranchInstId, animalInstId: animal.animalInstId, bucketType });
            }
        }
    });
    if (enabled('autoUpgradeRanch') || enabled('autoUpgradeFacilities')) await safely(async () => {
        for (const facility of (await service.getStatus()).facilities) {
            const key = facility.facilityKind === 'MODULE_TYPE_MAIN_CITY' ? 'autoUpgradeRanch' : 'autoUpgradeFacilities';
            if (!enabled(key)) continue;
            if (Number(facility.state) === 3 && facility.facilityKind === 'MODULE_TYPE_RANCH_SHED') {
                await perform({ action: 'activateFacility', facilityInstId: facility.instId }, key);
                continue; // Upgrade from a fresh snapshot on the next scheduler pass.
            }
            if (facility.state != null && Number(facility.state) !== 1) continue;
            if (facility.upgradeState) {
                if (Number(facility.upgradeEndTime) > 0 && Number(facility.upgradeEndTime) * 1000 <= (ctx.now || Date.now)()) await perform({ action: 'completeUpgrade', facilityInstId: facility.instId }, key);
            } else if (facility.nextLevel && facility.nextUpgradeCost.length && !facility.upgradeBlockedReason) {
                await perform({ action: 'upgradeBuilding', facilityInstId: facility.instId, costs: facility.nextUpgradeCost }, key);
            }
        }
    });
    // 帮指定好友的牧草机补草：只认白名单（feedFriendGids），空名单视为未配置、一个请求都不发，
    // 避免把仓库牧草倒给全好友。默认消耗仓库牧草（保留 feedReserveCount）；打开 feedFriendUseGold 后
    // 改用金券按容量补满（抓包实测 60 金券/单位），同样受 goldReserve 保留量约束。
    if (enabled('autoFriendFeed')) await safely(async () => {
        const visitFriend = service.withFriendVisit || ((_host, fn) => fn());
        let surplus = null;
        let goldBudget = null;
        for (const hostGid of policy().feedFriendGids) {
            if (!enabled('autoFriendFeed')) break;
            if (!policy().feedFriendGids.includes(hostGid)) continue;
            const useGold = policy().feedFriendUseGold === true;
            if (useGold) {
                if (goldBudget == null) {
                    const state = await service.getStatus();
                    if (state.sectionErrors?.warehouse) return;
                    goldBudget = stock(state.items, GOLD_ITEM_ID, true) - BigInt(policy().goldReserve);
                }
                if (goldBudget <= 0n) break;
            } else {
                if (surplus == null) {
                    const state = await service.getStatus();
                    if (state.sectionErrors?.warehouse) return;
                    surplus = stock(state.items, FEED_ITEM_ID, true) - BigInt(policy().feedReserveCount);
                }
                if (surplus <= 0n) break;
            }
            await safely(() => visitFriend(hostGid, async () => {
                const visit = await service.action({ action: 'visitFriend', hostGid });
                for (const facility of visit.friend?.facilities || []) {
                    const machine = facility?.feedMachine;
                    if (!machine || !enabled('autoFriendFeed')) continue;
                    const gap = feedFillTarget(facility.capacity, machine.feedCount, policy()) - Number(machine.feedCount);
                    if (!(gap > 0)) continue;
                    if (useGold) {
                        const cost = BigInt(gap) * FEED_GOLD_UNIT_COST;
                        if (goldBudget < cost) continue;
                        if (await perform({ action: 'friendFeed', hostGid, facilityInstId: facility.instId, useGold: true }, 'autoFriendFeed')) goldBudget -= cost;
                        continue;
                    }
                    if (surplus <= 0n) continue;
                    const count = cap(gap, surplus, 2147483647);
                    if (count > 0 && await perform({ action: 'friendFeed', hostGid, facilityInstId: facility.instId, count }, 'autoFriendFeed')) surplus -= BigInt(count);
                }
            }));
        }
    });
    const friendKeys = ['autoSteal', 'autoHelp', 'autoStroke', 'autoPutHazard'];
    if (friendKeys.some(enabled) && !quietNow(policy(), (ctx.now || Date.now)())) await safely(async () => {
        const p = policy();
        const continuation = ctx.continuation;
        if (ctx.maturityPlan && !continuation?.friendBatch && !ctx.maturityPlan.isDue(settings())) return;
        let friends, size, start;
        let prefetchSummary = null;
        if (continuation?.friendBatch) ({ friends, size, start } = continuation.friendBatch);
        else {
            const all = (await service.getResource('friends')).friends || [];
            friends = all.filter(f => !p.friendExcludeGids.includes(String(f.gid)) && (!p.friendIncludeGids.length || p.friendIncludeGids.includes(String(f.gid))));
            // 好友状态预取：GetGameFriends 一次批量（50 GID/次）返回每位好友的
            // big_farm_status（可偷/可接生/可帮），是官方好友列表置顶排序的数据源。
            // 按状态只巡访有活干的好友，替代盲巡访；预取失败（null）回退全量名单。
            // 只有结果会被用到的轮次才预取：steal 组（靠它筛可偷/可接生），或纯帮助模式
            // （靠它筛可帮）。开着抚摸/放蚊子的 help 组拿到状态也用不上，每 10~15 秒白打一轮
            // 状态读请求（600 好友时一轮 12 条），既挤占驻留时间也放大限频风险。
            const pureHelpStatusFilter = settings().autoHelp && !settings().autoStroke && !settings().autoPutHazard;
            let statusMap = null;
            if (ctx.friendRanchStatus && (ctx.maturityPlan || pureHelpStatusFilter)) {
                try { statusMap = await ctx.friendRanchStatus(friends.map(f => f.gid)); } catch { statusMap = null; }
            }
            if (statusMap) {
                prefetchSummary = { requested: friends.length, actionable: 0, used: true };
                const actionable = ctx.maturityPlan
                    // steal 组：可偷货架或可接生（接生后才偷得到）才值得进场。
                    ? gid => { const s = statusMap[gid]; return !!s && (s.canSteal || s.canMidwife); }
                    // help 组：抚摸/放蚊子没有列表态标记，只有纯帮助（清灾害）开启时才按状态筛。
                    : (pureHelpStatusFilter ? gid => { const s = statusMap[gid]; return !!s && s.canHelp; } : null);
                if (actionable) friends = friends.filter(f => actionable(String(f.gid)));
                prefetchSummary.actionable = friends.length;
            } else prefetchSummary = { requested: friends.length, actionable: friends.length, used: false };
            if (ctx.maturityPlan) friends = ctx.maturityPlan.select(friends, p.friendBatchSize, settings(), p);
            size = Math.min(friends.length, p.friendBatchSize);
            start = ctx.maturityPlan ? 0 : friends.length ? getCursor() % friends.length : 0;
            if (continuation) continuation.friendBatch = { friends, size, start, completed: new Set() };
        }
        if (!friends.length) setCursor(0);
        // 偷取巡访诊断：记录每轮「为什么没偷」——到现场时的动物/货架状态与实际动作数，
        // 供排查“开了偷产物但统计没有偷”。只在成熟计划在场的轮次（steal 组）输出。
        const stealPlanEnabled = !!ctx.maturityPlan;
        const stealVisits = [];
        // 配额观察：GetRanchOpTimes 的 remainingTimes 是账号级当日额度。启用的好友动作
        // 全部用尽且没有无配额限制的工作（清灾害）时，把下次唤醒推迟到配额重置（北京 0 点），
        // 避免每 10~15 秒白跑一轮巡访。
        const quotaObserved = { stroke: null, hazard: null, cleanWork: false, visits: 0 };
        const quotaRemaining = (friend, opId) => {
            const value = String(friend?.ops?.find(op => String(op.opId) === opId)?.remainingTimes ?? '');
            return /^\d+$/.test(value) ? BigInt(value) : null;
        };
        for (let offset = 0; offset < size; offset++) await safely(async () => {
            if (!friendKeys.some(enabled)) return;
            if (continuation?.friendBatch.completed.has(offset)) return;
            setCursor((start + offset + 1) % friends.length);
            const hostGid = String(friends[(start + offset) % friends.length].gid);
            const current = policy();
            if (current.friendExcludeGids.includes(hostGid) || (current.friendIncludeGids.length && !current.friendIncludeGids.includes(hostGid))) return;
            const visitFriend = service.withFriendVisit || ((_host, fn) => fn());
            await visitFriend(hostGid, async () => {
            const visit = await service.action({ action: 'visitFriend', hostGid });
            ctx.maturityPlan?.observe(hostGid, visit.friend?.ranches);
            const visitStats = stealPlanEnabled ? { hostGid, animals: 0, producing: 0, grassBlocked: 0, readyToTrigger: 0, readyShelves: 0, nextReadyInSec: null, triggered: 0, stolen: 0, visited: true } : null;
            // Missing quota is not permission to write. Refresh from each completed
            // hazard action so multiple sheds cannot reuse the same remaining count.
            const hazardQuota = friend => {
                const value = String(friend?.ops?.find(op => String(op.opId) === '11003')?.remainingTimes ?? '');
                return /^\d+$/.test(value) ? BigInt(value) : 0n;
            };
            let hazardsRemaining = hazardQuota(visit.friend);
            quotaObserved.visits += 1;
            {
                const strokeLeft = quotaRemaining(visit.friend, '11009');
                if (strokeLeft != null && (quotaObserved.stroke === null || strokeLeft < quotaObserved.stroke)) quotaObserved.stroke = strokeLeft;
                const hazardLeft = quotaRemaining(visit.friend, '11003');
                if (hazardLeft != null && (quotaObserved.hazard === null || hazardLeft < quotaObserved.hazard)) quotaObserved.hazard = hazardLeft;
            }
            for (const ranch of visit.friend?.ranches || []) {
                const base = { hostGid, ranchId: ranch.ranchInstId };
                if (visitStats) {
                    visitStats.animals += (ranch.animals || []).length;
                    for (const animal of ranch.animals || []) {
                        if (animal.producing) visitStats.producing += 1;
                        if (animal.grassBlocked) visitStats.grassBlocked += 1;
                        if (animal.canTriggerProduce) visitStats.readyToTrigger += 1;
                        const ready = Number(animal.produceReadyAtMs);
                        if (Number.isFinite(ready) && ready > (ctx.now || Date.now)()) visitStats.nextReadyInSec = Math.min(visitStats.nextReadyInSec ?? Infinity, Math.round((ready - (ctx.now || Date.now)()) / 1000));
                    }
                }
                if (enabled('autoHelp') && (!ctx.maturityPlan || ctx.maturityPlan.canHelp(hostGid)) && ranch.hazards?.length) {
                    if (settings().autoHelp) quotaObserved.cleanWork = true;
                    await perform({ ...base, action: 'help' });
                }
                // Production can immediately create stealable shelves. Only consume freshly
                // queried shelves, never infer loot or retry a completed production write.
                let stealRanch = ranch;
                if (enabled('autoSteal') && (!ctx.maturityPlan || ctx.maturityPlan.canSteal(hostGid))) {
                    for (const animal of ranch.animals || []) if (animal.canTriggerProduce) {
                        const produced = await perform({ ...base, action: 'friendProduce', animalInstId: animal.animalInstId });
                        if (produced) {
                            stealRanch = produced.friend?.ranches?.find(r => String(r.ranchInstId) === String(ranch.ranchInstId)) || { shelves: [] };
                            if (visitStats) visitStats.triggered += 1;
                        }
                    }
                }
                if (enabled('autoSteal') && (!ctx.maturityPlan || ctx.maturityPlan.canSteal(hostGid))) {
                    // 一键偷取：对服务端确认可偷的货架只发一条空 targets 的 StealProduce，
                    // 服务端筛选全偷（好友有多货架时从 N 条写请求降到 1 条）。
                    const stealable = (stealRanch.shelves || []).filter(shelf => shelf.canSteal);
                    if (visitStats) visitStats.readyShelves += stealable.length;
                    if (stealable.length) {
                        const stolen = await perform({ ...base, action: 'steal', stealAll: true });
                        if (visitStats && stolen) visitStats.stolen += Number(stolen.reply?.opResults?.filter(row => row.kind === 2 && (row.rewards || []).length).length || 0);
                    }
                }
                if (enabled('autoStroke') && (!ctx.maturityPlan || ctx.maturityPlan.canHelp(hostGid))) for (const animal of ranch.animals || []) if (animal.canStroke) await perform({ ...base, action: 'stroke', animalInstId: animal.animalInstId });
                if (enabled('autoPutHazard') && hazardsRemaining > 0n && (!ctx.maturityPlan || ctx.maturityPlan.canHelp(hostGid))) {
                    const placed = await perform({ ...base, action: 'putHazard' });
                    hazardsRemaining = hazardQuota(placed?.friend);
                }
            }
            if (visitStats) stealVisits.push(visitStats);
            // Keep the current friend in the continuation until all its safe actions
            // have been considered. Maturity observation must not discard a yielded tail.
            if (alive() && used < policy().maxActionsPerRun) continuation?.friendBatch.completed.add(offset);
            });
        });
        // 配额排班：仅当本轮完整跑完、启用的配额型动作（抚摸/放蚊子）全部被服务端确认用尽、
        // 且没有配额无关的工作（清灾害/剩余额度）时，把下次唤醒推迟到配额重置（北京 0 点）。
        // 只推 help 组（steal 组的 enabled 不含这两项，条件自然不成立）。
        if (ctx.extra && alive() && quotaObserved.visits > 0) {
            const strokeOn = settings().autoStroke === true;
            const hazardOn = settings().autoPutHazard === true;
            const strokeExhausted = strokeOn && quotaObserved.stroke === 0n;
            const hazardExhausted = hazardOn && quotaObserved.hazard === 0n;
            const otherWork = (settings().autoHelp === true && quotaObserved.cleanWork)
                || (strokeOn && quotaObserved.stroke !== null && quotaObserved.stroke > 0n)
                || (hazardOn && quotaObserved.hazard !== null && quotaObserved.hazard > 0n);
            if (!otherWork && (!strokeOn || strokeExhausted) && (!hazardOn || hazardExhausted) && (strokeExhausted || hazardExhausted)) {
                const at = (ctx.now || Date.now)();
                const serverSec = Math.floor((ctx.serverNow ? ctx.serverNow() : at) / 1000);
                const resetSec = serverSec + 86400 - ((serverSec + 8 * 3600) % 86400);
                ctx.extra.quotaResetAtMs = at + (resetSec - serverSec) * 1000;
            }
        }
        if (stealPlanEnabled && stealVisits.length && ctx.logEvent) {
            const totals = stealVisits.reduce((acc, v) => ({
                animals: acc.animals + v.animals, producing: acc.producing + v.producing, grassBlocked: acc.grassBlocked + v.grassBlocked,
                readyToTrigger: acc.readyToTrigger + v.readyToTrigger, readyShelves: acc.readyShelves + v.readyShelves, triggered: acc.triggered + v.triggered, stolen: acc.stolen + v.stolen,
            }), { animals: 0, producing: 0, grassBlocked: 0, readyToTrigger: 0, readyShelves: 0, triggered: 0, stolen: 0 });
            const plan = ctx.maturityPlan.inspect?.() || {};
            const nextReady = stealVisits.map(v => v.nextReadyInSec).filter(t => Number.isFinite(t));
            ctx.logEvent(`偷取巡访 ${stealVisits.length} 位（到期 ${plan.due ?? '?'}／校准 ${plan.calibrated ?? '?'}，计划 ${plan.plans ?? '?'} 人${prefetchSummary ? `；${prefetchSummary.requested} 人→可行动 ${prefetchSummary.actionable}${prefetchSummary.used ? '' : '，状态读取失败回退全量'}` : ''}）：动物 ${totals.animals} 只，产中 ${totals.producing}（放草 ${totals.grassBlocked}）、待触发 ${totals.readyToTrigger}，可偷货架 ${totals.readyShelves}，触发生产 ${totals.triggered}，偷到 ${totals.stolen}${nextReady.length ? `，最近成熟 ${Math.round(Math.min(...nextReady) / 60)} 分钟后` : ''}`, {
                event: 'stealPlan', result: totals.stolen > 0 ? 'ok' : 'none', prefetch: prefetchSummary,
                visits: stealVisits.map(v => ({ hostGid: v.hostGid, animals: v.animals, producing: v.producing, grassBlocked: v.grassBlocked, readyToTrigger: v.readyToTrigger, readyShelves: v.readyShelves, triggered: v.triggered, stolen: v.stolen, nextReadyInSec: Number.isFinite(v.nextReadyInSec) ? v.nextReadyInSec : null })),
            });
        } else if (stealPlanEnabled && prefetchSummary?.used && prefetchSummary.actionable === 0 && ctx.logEvent) {
            // 预取说整份名单都没人可偷/可接生：留一条痕，避免「为什么一轮都没进别人家」无从排查。
            ctx.logEvent(`${prefetchSummary.requested} 位好友，无可偷货架、无可接生动物，本轮跳过巡访`, { event: 'stealPlan', result: 'none', prefetch: prefetchSummary });
        }
    });
}
module.exports = { runRanchExtraAutomation, assertAutomationPolicy };
