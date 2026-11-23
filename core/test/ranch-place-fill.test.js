// 单元测试不做写请求节流（生产默认 300ms），否则每个用例都要真等。
process.env.RANCH_ACTION_GAP_MS = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRanchService } = require('../src/services/ranch');
const { createRanchSession } = require('../src/services/ranch-session');
const { normalizePolicy, SETTINGS_KEYS } = require('../src/services/ranch-settings');

/**
 * 自建夹具：专注验证「自动入栏」填满栏位的行为
 * 1) legacy 模式（自定义 cubItemIds）：cubItemIds 是「买哪些品种入栏」的白名单，
 *    每轮每栏买一只（BuyGoods auto_add）。
 * 2) 同一栏位、同一品种要能连续放入多只：动作去重身份必须跟着栏位数量变化，
 *    否则放一只之后就再也不放了，栏位永远填不满。
 */
function fixture(options = {}) {
    const calls = [];
    const logs = [];
    const automation = { ranch_policy: normalizePolicy() };
    // 窝：容量 6（鸭 60002）；棚：容量 3（羊 70001）
    const own = { ranch_inst_id: '9007199254740993', husbandry_type: 1, animal_count: 0, capacity: 6, animals: [], shelves: [], hazards: [] };
    const shed = { ranch_inst_id: '9007199254740994', husbandry_type: 2, animal_count: 0, capacity: 3, animals: [], shelves: [], hazards: [] };
    const items = [
        { id: '60002', uid: '11', count: '0' },   // 鸭（栏位目标品种）
        { id: '70001', uid: '12', count: '0' },   // 羊（栏位目标品种）
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
                // 原始 RPC 返回是 snake_case；getResource('shop') 会再驼峰化成 goodsList
                // conds 里 type=3 是「最低大农场等级」，选种要按它降序
                goods_list: [
                    // 商品 id / item_id / 等级门槛都对齐官方配置
                    { id: 10003, item_id: 60002, price: '1080', unlocked: true, owned: false, limit_count: '0', bought_num: '0', conds: [{ type: 3, param: '3' }] },   // 鸭 Lv3
                    { id: 10006, item_id: 60005, price: '5640', unlocked: true, owned: false, limit_count: '0', bought_num: '0', conds: [{ type: 3, param: '14' }] },  // 火鸡 Lv14
                    { id: 10008, item_id: 70001, price: '5640', unlocked: true, owned: false, limit_count: '0', bought_num: '0', conds: [{ type: 3, param: '21' }] },  // 羊 Lv21
                    { id: 10012, item_id: 70003, price: '8448', unlocked: true, owned: false, limit_count: '0', bought_num: '0', conds: [{ type: 3, param: '29' }] },  // 驴 Lv29
                ],
            };
            case 'BuyGoods': {
                placeCalls.push(params);
                // 买入即入栏：栏位数量 +1
                const target = String(params.goods_id);
                const ranch = target === '10008' || target === '10012' ? shed : own;
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
        friendRosterDir: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ranch-place-')),
        serverNow: Date.now,
        log: (...args) => logs.push(args),
        rpc: async (method, params) => {
            calls.push({ method, params });
            if (options.overrides && options.overrides[method]) return options.overrides[method](params);
            return structuredClone(responses(method, params));
        },
    });
    const enable = (...keys) => { for (const key of keys) automation[SETTINGS_KEYS[key]] = true; };
    const setPolicy = patch => { automation.ranch_policy = normalizePolicy({ ...automation.ranch_policy, ...patch }, true); };
    return { service, calls, logs, automation, enable, setPolicy, own, shed, items, placeCalls };
}

test('legacy 模式：在白名单里养当前等级养得起的最高级动物（不是白名单第一项）', async () => {
    const f = fixture();
    f.enable('autoPlace');
    // 白名单同时含低等级的鸭(Lv3)和火鸡(Lv14)，应选等级更高的火鸡
    f.setPolicy({ mode: 'legacy', cubItemIds: ['60002', '60005', '70001'] });

    await f.service.runAutomation();

    const buys = f.calls.filter(c => c.method === 'BuyGoods');
    assert.ok(buys.length >= 1, '应该买并入栏');
    assert.equal(buys[0].params.auto_add, true, '应使用 auto_add 直接入栏');
    assert.equal(String(buys[0].params.goods_id), '10006', '应选等级门槛最高的火鸡(Lv14)，而不是排最前的鸭(Lv3)');
});

test('legacy 模式：白名单为空时这一轮不放（place 要求品种在白名单里）', async () => {
    const f = fixture();
    f.enable('autoPlace');
    f.setPolicy({ mode: 'legacy', cubItemIds: [] });

    await f.service.runAutomation();

    assert.equal(f.placeCalls.length, 0, '白名单为空不该放入任何品种');
});

test('同一栏位同一品种可以连续放入多只（动作去重不能挡住）', async () => {
    const f = fixture();
    f.enable('autoPlace');
    f.setPolicy({ mode: 'legacy', cubItemIds: ['60002'] });

    await f.service.runAutomation();
    const first = f.placeCalls.length;
    assert.ok(first >= 1, '第一次应放入一只');

    // 栏位数量变了 → 身份必须变 → 允许继续放
    await f.service.runAutomation();
    await f.service.runAutomation();

    assert.ok(f.placeCalls.length > first, '后续轮次应继续放入，而不是被去重挡住');
    assert.ok(f.own.animal_count >= 2, '栏位数量应随放入递增');
});

test('白名单里的品种当前都买不到时，这轮不放（不偷买清单外的）', async () => {
    const f = fixture();
    f.enable('autoPlace');
    // 60007 乌龟：不在商店可买列表里
    f.setPolicy({ mode: 'legacy', cubItemIds: ['60007'] });

    await f.service.runAutomation();

    assert.equal(f.placeCalls.length, 0, '买不到就不该放入，也不该买清单外的品种');
});
