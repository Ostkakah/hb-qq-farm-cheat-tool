// 单元测试不做写请求节流（生产默认 300ms），否则每个用例都要真等。
process.env.RANCH_ACTION_GAP_MS = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRanchService } = require('../src/services/ranch');
const { createRanchSession } = require('../src/services/ranch-session');
const { normalizePolicy, SETTINGS_KEYS } = require('../src/services/ranch-settings');
const { giantCubInfo, isGiantCubItem } = require('../src/services/ranch-strategy');

/**
 * 巨大化幼崽优先入栏。
 *
 * 官方口径（core/src/proto/ranch.proto）：
 *   animal_PlaceAnimalItem { ranch_inst_id, animal_id, giant_cub_item_id }
 * 巨大化幼崽不是独立品种 —— animal_id 仍是基础品种，巨大幼崽走 giant_cub_item_id 单独指定。
 * 官方 MCItemInfo 里「巨大X幼崽」(type=105) 与普通幼崽同品种，id 规律为普通幼崽 id + 5000
 * （60009 刺猬 → 65009 巨大刺猬幼崽；70006 水牛 → 75006 巨大水牛幼崽）。
 *
 * 规则：栏位有空时优先放牧背包里的巨大化幼崽（商店买不到、放一只少一只），
 * 没有合适的巨大幼崽再走原策略（商店购买 / 背包普通幼崽）。
 */
function fixture(options = {}) {
    const calls = [];
    const logs = [];
    const automation = { ranch_policy: normalizePolicy() };
    const own = { ranch_inst_id: '9007199254740993', husbandry_type: 1, animal_count: 0, capacity: 6, animals: [], shelves: [], hazards: [] };
    const shed = { ranch_inst_id: '9007199254740994', husbandry_type: 2, animal_count: 0, capacity: 3, animals: [], shelves: [], hazards: [] };
    // 默认背包里有：巨大刺猬幼崽（窝）、巨大水牛幼崽（棚）
    const items = options.items || [
        { id: '65009', uid: '21', count: '1' },   // 巨大刺猬幼崽（刺猬 60009，窝）
        { id: '75006', uid: '22', count: '1' },   // 巨大水牛幼崽（水牛 70006，棚）
        { id: '1007', count: '100000' },
    ];
    const cells = {
        facilities: [
            { instance_id: '10001', facility_id: 6001001, ranch: own },
            { instance_id: '10003', facility_id: 6002004, ranch: shed },
        ],
        building_items: [],
    };
    const placeCalls = [];
    const responses = (method, params) => {
        switch (method) {
            case 'AllCells': return cells;
            case 'GetRanchDetail': return { ranches: [own, shed] };
            case 'GetBag': return { physical_items: items };
            case 'GetBagTab': case 'GetOrderPanel': case 'InteractRecords': case 'LeaveHomestead': return {};
            case 'GetAll': return { game_friends: [] };
            case 'GetGameFriends': return { friends: [] };
            case 'GetRanchOpTimes': return { ops: [] };
            case 'ShopProfiles': return { shops: [] };
            case 'ShopInfo': return {
                goods_list: [
                    { id: 10003, item_id: 60002, price: '1080', unlocked: true, owned: false, limit_count: '0', bought_num: '0', conds: [{ type: 3, param: '3' }] },   // 鸭 Lv3（窝）
                    { id: 10008, item_id: 70001, price: '5640', unlocked: true, owned: false, limit_count: '0', bought_num: '0', conds: [{ type: 3, param: '21' }] },  // 羊 Lv21（棚）
                ],
            };
            case 'PlaceAnimal': {
                placeCalls.push(params);
                const target = String(params.items?.[0]?.ranch_inst_id);
                const ranch = target === String(shed.ranch_inst_id) ? shed : own;
                ranch.animal_count = Number(ranch.animal_count || 0) + 1;
                // 入栏会消耗背包里的幼崽（巨大幼崽走 giant_cub_item_id）
                const consumed = String(params.items?.[0]?.giant_cub_item_id || '');
                const entry = items.find(i => String(i.id) === consumed);
                if (entry) entry.count = String(Math.max(0, Number(entry.count || 0) - 1));
                return { op_results: [] };
            }
            case 'BuyGoods': {
                placeCalls.push(params);
                const target = String(params.goods_id);
                const ranch = target === '10008' ? shed : own;
                ranch.animal_count = Number(ranch.animal_count || 0) + 1;
                return { op_results: [] };
            }
            default: throw new Error(`Unexpected RPC ${method}`);
        }
    };
    const session = createRanchSession();
    const service = createRanchService({
        session,
        getUserState: () => ({ gid: '123' }),
        getSettings: () => automation,
        friendRosterDir: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ranch-giant-')),
        serverNow: Date.now,
        log: (...args) => logs.push(args),
        rpc: async (method, params) => {
            calls.push({ method, params });
            return structuredClone(responses(method, params));
        },
    });
    const enable = (...keys) => { for (const key of keys) automation[SETTINGS_KEYS[key]] = true; };
    const setPolicy = patch => { automation.ranch_policy = normalizePolicy({ ...automation.ranch_policy, ...patch }, true); };
    return { service, calls, logs, automation, enable, setPolicy, own, shed, items, placeCalls };
}

test('PlaceAnimal 上线格式：巨大幼崽走 giant_cub_item_id，普通幼崽不带该字段', () => {
    const { createRanchProtocol } = require('../src/services/ranch-protocol');
    const protocol = createRanchProtocol();
    const type = protocol.rpc.PlaceAnimal.requestType;

    const giant = type.toObject(type.decode(protocol.encode('PlaceAnimal', {
        items: [{ ranch_inst_id: '9007199254740993', animal_id: '60009', giant_cub_item_id: '65009' }],
    })), { longs: String });
    assert.equal(giant.items[0].giant_cub_item_id, '65009', '巨大幼崽 id 必须上线');
    assert.equal(giant.items[0].animal_id, '60009', 'animal_id 是基础品种');

    const normal = type.toObject(type.decode(protocol.encode('PlaceAnimal', {
        items: [{ ranch_inst_id: '1', animal_id: '60002' }],
    })), { longs: String, defaults: true });
    assert.equal(normal.items[0].giant_cub_item_id, '0', '普通幼崽不带该字段（proto3 缺省 0）');
});

test('官方巨大化幼崽映射：id 规律 + 名称都对得上才认', () => {
    assert.equal(isGiantCubItem('65009'), true);
    assert.equal(isGiantCubItem('75006'), true);
    assert.equal(isGiantCubItem('60009'), false, '普通幼崽不是巨大幼崽');
    assert.equal(isGiantCubItem('99999'), false);
    const info = giantCubInfo('65009');
    assert.equal(info.animalId, '60009', '巨大刺猬幼崽对应刺猬品种');
    assert.equal(info.baseItemId, '60009');
    assert.equal(info.husbandryType, '窝');
    assert.equal(giantCubInfo('75006').animalId, '70006');
    assert.equal(giantCubInfo('75006').husbandryType, '棚');
});

test('有空位时优先放牧背包里的巨大化幼崽，不去买商店', async () => {
    const f = fixture();
    f.enable('autoPlace');
    f.setPolicy({ mode: 'legacy', cubItemIds: ['60002', '60009', '70001', '70006'] });

    await f.service.runAutomation();

    const placed = f.calls.filter(c => c.method === 'PlaceAnimal');
    assert.ok(placed.length >= 1, '应该放牧背包里的巨大幼崽');
    const buys = f.calls.filter(c => c.method === 'BuyGoods');
    assert.equal(buys.length, 0, '有巨大幼崽时不该去买商店');

    const items = placed.flatMap(c => c.params.items || []);
    assert.ok(items.length >= 1);
    for (const item of items) {
        assert.ok(['65009', '75006'].includes(String(item.giant_cub_item_id)), `应带巨大幼崽 id，实际 ${JSON.stringify(item)}`);
        assert.ok(['60009', '70006'].includes(String(item.animal_id)), 'animal_id 必须是基础品种');
    }
});

test('巨大幼崽按品种匹配栏舍：棚的巨大水牛幼崽不会放进窝', async () => {
    const f = fixture({ items: [{ id: '75006', uid: '22', count: '1' }, { id: '1007', count: '100000' }] });
    f.enable('autoPlace');
    f.setPolicy({ mode: 'legacy', cubItemIds: ['60002', '70001', '70006'] });

    await f.service.runAutomation();

    const placed = f.calls.filter(c => c.method === 'PlaceAnimal');
    assert.ok(placed.length >= 1, '棚应该放巨大水牛幼崽');
    for (const call of placed) {
        const item = call.params.items[0];
        assert.equal(String(item.giant_cub_item_id), '75006');
        assert.equal(String(item.animal_id), '70006');
        assert.equal(String(item.ranch_inst_id), '9007199254740994', '只能进棚');
    }
    // 窝里没有巨大幼崽可放，只能按原策略买商店的鸭
    const buys = f.calls.filter(c => c.method === 'BuyGoods');
    assert.ok(buys.length >= 1, '窝没有巨大幼崽时按原策略买');
});

test('巨大幼崽品种不在白名单时不放（仍按白名单买商店）', async () => {
    const f = fixture();
    f.enable('autoPlace');
    f.setPolicy({ mode: 'legacy', cubItemIds: ['60002'] });

    await f.service.runAutomation();

    const placed = f.calls.filter(c => c.method === 'PlaceAnimal');
    assert.equal(placed.length, 0, '白名单外的巨大幼崽不该入栏');
    const buys = f.calls.filter(c => c.method === 'BuyGoods');
    assert.ok(buys.length >= 1, '按白名单买商店');
});

test('巨大幼崽放完后回落到原策略（继续买商店填栏位）', async () => {
    const f = fixture({ items: [{ id: '65009', uid: '21', count: '1' }, { id: '1007', count: '100000' }] });
    f.enable('autoPlace');
    f.setPolicy({ mode: 'legacy', cubItemIds: ['60002', '60009'] });

    await f.service.runAutomation();
    const placedFirst = f.calls.filter(c => c.method === 'PlaceAnimal').length;
    assert.ok(placedFirst >= 1, '第一轮放巨大幼崽');

    await f.service.runAutomation();
    await f.service.runAutomation();

    const buys = f.calls.filter(c => c.method === 'BuyGoods');
    assert.ok(buys.length >= 1, '巨大幼崽用完后应继续买商店填栏位');
});

test('背包没有巨大幼崽时行为不变：仍按白名单买商店', async () => {
    const f = fixture({ items: [{ id: '1007', count: '100000' }] });
    f.enable('autoPlace');
    f.setPolicy({ mode: 'legacy', cubItemIds: ['60002', '70001'] });

    await f.service.runAutomation();

    assert.equal(f.calls.filter(c => c.method === 'PlaceAnimal').length, 0, '没有巨大幼崽就不该走背包放置');
    assert.ok(f.calls.filter(c => c.method === 'BuyGoods').length >= 1);
});
