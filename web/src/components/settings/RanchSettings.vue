<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useAccountStore } from '@/stores/account'

const account = useAccountStore()
const data = ref<any>(null)
const draft = ref<Record<string, boolean>>({})
const policy = ref<any>({})
const friends = ref<any[]>([])
const friendsLoading = ref(false)
const friendsError = ref('')
const feedFriendQuery = ref('')
const feedFriendList = computed(() => {
  const keyword = feedFriendQuery.value.trim().toLowerCase()
  const list = Array.isArray(friends.value) ? friends.value : []
  if (!keyword) return list
  return list.filter((friend: any) => String(friend.name || '').toLowerCase().includes(keyword) || String(friend.gid ?? '').includes(keyword))
})
const feedFriendCount = computed(() => (Array.isArray(policy.value.feedFriendGids) ? policy.value.feedFriendGids.length : 0))
const active = ref('')
const loading = ref(false)
const error = ref('')
let generation = 0
let controller: AbortController | null = null
const modules = [
  { key: 'husbandry', title: '养殖与收获', description: '养殖策略、收获、出售和巡查节奏', icon: 'i-carbon-sprout' },
  { key: 'feed', title: '饲料与设施', description: '牧场升级、设施升级和罐头使用', icon: 'i-carbon-wheat' },
  { key: 'friends', title: '牧场好友', description: '帮助、照料和好友捣乱', icon: 'i-carbon-user-multiple' },
  { key: 'steal', title: '牧场偷取', description: '根据好友产出时间自动巡查', icon: 'i-carbon-crop-health' },
  { key: 'merchant', title: '兑换集市', description: '使用便便、松果兑换商品', icon: 'i-carbon-store' },
  { key: 'activity', title: '日常与活动', description: '订单、图鉴奖励和限时活动', icon: 'i-carbon-events' },
]
const moduleImages: Record<string, string> = {
  husbandry: 'planting.png',
  feed: 'fertilizer.png',
  friends: 'friends-friendship.png',
  steal: 'steal.png',
  merchant: 'merchant.png',
  activity: 'activity-task.png',
}
const activeInfo = computed(() => modules.find(m => m.key === active.value))
const policyKeys: Record<string, string[]> = {
  husbandry: ['husbandryStrategy', 'husbandryFallbackStrategy', 'farmMin', 'farmMax'],
  feed: ['canStrategy', 'smartSeconds', 'feedThresholdPercent', 'feedReserveCount', 'addFeedUseGold'],
  friends: ['helpMin', 'helpMax', 'quietEnabled', 'quietStart', 'quietEnd', 'feedFriendGids', 'feedFriendUseGold'],
  steal: [],
  merchant: [],
  activity: [],
}
const husbandryFallbackOptions = [
  { label: '任务幼崽优先（无任务时最高等级）', value: 'task' },
  { label: '最高等级幼崽', value: 'level' },
  { label: '最大基础经验／时', value: 'max_exp' },
  { label: '最大基础产值／时', value: 'max_profit' },
]
const husbandryOptions = [{ label: '牧场幼崽优先（背包优先）', value: 'bag_priority' }, ...husbandryFallbackOptions]
const canOptions = [
  { label: '有机 + 无机', value: 'both' },
  { label: '有机 + 快成熟无机', value: 'smart' },
  { label: '快成熟无机', value: 'smart_only' },
  { label: '快成熟有机', value: 'smart_normal' },
  { label: '仅有机罐头', value: 'normal' },
  { label: '仅无机罐头', value: 'organic' },
  { label: '不使用罐头', value: 'none' },
]
const options = computed(() => [
  { key: 'autoPlace', label: '自动入栏', capability: 'place', module: 'husbandry' },
  { key: 'autoAddFeed', label: '自动补充已有牧草', capability: 'addFeed', module: 'feed' },
  { key: 'autoUseCan', label: '自动装填罐头容器', capability: 'useCan', module: 'feed' },
  { key: 'autoHelp', label: '自动帮助好友清理灾害', capability: 'friendActions', module: 'friends' },
  { key: 'autoStroke', label: '自动照料好友动物', capability: 'friendActions', module: 'friends' },
  { key: 'autoFriendFeed', label: '自动给指定好友加牧草', capability: 'friendActions', module: 'friends' },
  { key: 'autoPutHazard', label: '自动向好友牧场放蚊子', capability: 'friendActions', module: 'friends' },
  { key: 'autoSteal', label: '自动偷取好友货架产物', capability: 'friendActions', module: 'steal' },
  { key: 'autoSell', label: '自动出售产物', capability: 'sell', module: 'husbandry' },
  { key: 'autoExchangePoop', label: '使用便便兑换', capability: 'exchange', module: 'merchant' },
  { key: 'autoExchangePine', label: '使用松果兑换', capability: 'exchange', module: 'merchant' },
  { key: 'autoUpgradeRanch', label: '升级牧场', capability: 'upgradeBuilding', module: 'feed' },
  { key: 'autoUpgradeFacilities', label: '解锁棚与升级设施', capability: 'upgradeBuilding', module: 'feed' },
  { key: 'autoFeedAnimal', label: '自动使用罐头', capability: 'feedAnimal', module: 'feed' },
  { key: 'autoProduce', label: '自动开始生产', capability: 'produce', module: 'husbandry' },
  { key: 'autoCollect', label: '自动收集货架产物', capability: 'collect', module: 'husbandry' },
  { key: 'autoClean', label: '自动清理灾害', capability: 'clean', module: 'husbandry' },
  { key: 'autoHarvest', label: '自动收获动物（成熟后离栏）', capability: 'harvest', module: 'husbandry' },
  { key: 'autoClaimTasks', label: '自动领取每日、成长任务奖励', capability: 'claimTask', module: 'activity' },
  { key: 'autoSubmitOrders', label: '自动提交安全物品订单', capability: 'submitOrder', module: 'activity' },
  { key: 'autoClaimIllustrated', label: '自动领取牧场图鉴奖励', capability: 'claimIllustrated', module: 'activity' },
  { key: 'autoClaimWeight', label: '自动领取重量积分奖励', capability: 'claimWeight', module: 'activity' },
].filter(option => data.value?.capabilities?.[option.capability]))
function enabledCount(key: string) {
  return options.value.filter(o => o.module === key && data.value?.[o.key]).length
}
function moduleOptions(key: string) {
  return options.value.filter(o => o.module === key)
}
async function toggleModule(key: string, value: boolean) {
  edit(key)
  const defaults: Record<string, string[]> = {
    husbandry: ['autoPlace', 'autoProduce', 'autoCollect', 'autoClean', 'autoHarvest'],
    feed: ['autoAddFeed', 'autoUseCan', 'autoFeedAnimal'],
    friends: ['autoHelp', 'autoStroke'],
  }
  for (const option of moduleOptions(key))
    draft.value[option.key] = value && (defaults[key]?.includes(option.key) ?? true)
  await save()
}
async function load() {
  if (!account.currentAccountId || loading.value)
    return
  const version = generation
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const res = await api.get('/api/ranch/settings', { signal: controller.signal, headers: { 'x-account-id': account.currentAccountId } })
    if (!res.data.ok)
      throw new Error(res.data.error || '配置读取失败')
    if (version === generation)
      data.value = res.data.data
  }
  catch (e: any) {
    if (version === generation && e.code !== 'ERR_CANCELED')
      error.value = e.response?.data?.error || e.message
  }
  finally {
    if (version === generation)
      loading.value = false
  }
}
function edit(key: string) {
  active.value = key
  policy.value = JSON.parse(JSON.stringify(data.value?.policy || {}))
  policy.value.feedFriendGids = Array.isArray(policy.value.feedFriendGids) ? [...policy.value.feedFriendGids] : []
  draft.value = Object.fromEntries(options.value.map(o => [o.key, data.value?.[o.key] === true]))
  if (key === 'friends')
    void loadFriends()
}
async function loadFriends() {
  if (!account.currentAccountId)
    return
  friendsLoading.value = true
  friendsError.value = ''
  try {
    const res = await api.get('/api/ranch/friends', { headers: { 'x-account-id': account.currentAccountId } })
    if (!res.data.ok)
      throw new Error(res.data.error || '好友列表读取失败')
    friends.value = (res.data.data?.friends || [])
      .filter((friend: any) => /^[1-9]\d*$/.test(String(friend?.gid || '')))
      .map((friend: any) => ({ gid: String(friend.gid), name: friend.remark || friend.name || '' }))
  }
  catch (e: any) {
    friendsError.value = e.response?.data?.error || e.message
    friends.value = []
  }
  finally {
    friendsLoading.value = false
  }
}
function toggleFeedFriend(gid: string) {
  const list: string[] = Array.isArray(policy.value.feedFriendGids) ? policy.value.feedFriendGids : []
  policy.value.feedFriendGids = list.includes(gid) ? list.filter(id => id !== gid) : [...list, gid]
}
function clearFeedFriends() {
  policy.value.feedFriendGids = []
}
async function save() {
  if (!account.currentAccountId || loading.value)
    return
  const version = generation
  loading.value = true
  error.value = ''
  try {
    // 保存时下发完整策略，而不是只发当前模块的字段：
    // simple 模式在服务端会清空 buyRules / exchangeRules / canItemIds / feedFriendGids，
    // 只发部分字段会让这些自定义清单被一并抹掉。
    // 自定义过清单时保持 legacy（不覆盖用户配置）；从未自定义过则仍用 simple 的默认清单。
    const hasCustomRules = (policy.value.buyRules?.length || 0) > 0
      || (policy.value.exchangeRules?.length || 0) > 0
      || (policy.value.canItemIds?.length || 0) > 0
      || (policy.value.feedFriendGids?.length || 0) > 0;
    const patch = {
      ...Object.fromEntries(options.value.filter(o => o.module === active.value).map(o => [o.key, draft.value[o.key]])),
      policy: {
        ...policy.value,
        mode: hasCustomRules ? 'legacy' : 'simple',
        ...Object.fromEntries((policyKeys[active.value] || []).map(key => [key, policy.value[key]])),
      },
    }
    const res = await api.post('/api/ranch/settings', patch, { headers: { 'x-account-id': account.currentAccountId } })
    if (!res.data.ok)
      throw new Error(res.data.error || '保存失败')
    if (version === generation) {
      data.value = res.data.data
      active.value = ''
    }
  }
  catch (e: any) {
    if (version === generation)
      error.value = e.response?.data?.error || e.message
  }
  finally {
    if (version === generation)
      loading.value = false
  }
}
watch(() => account.currentAccountId, () => {
  generation++
  controller?.abort()
  active.value = ''
  data.value = null
  draft.value = {}
  policy.value = {}
  loading.value = false
  void load()
}, { immediate: true, flush: 'sync' })
onUnmounted(() => {
  generation++
  controller?.abort()
})
</script>

<template>
  <section class="space-y-4">
    <p v-if="error" class="rounded-lg bg-red-50 p-4 text-sm text-red-700" role="alert">
      {{ error }}
    </p>
    <p v-if="!account.currentAccountId" class="ui-card rounded-lg p-6">
      请先选择账号
    </p>
    <Teleport to="body">
      <div v-if="active && activeInfo && account.currentAccountId" class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-gray-950/45 p-3 backdrop-blur-[2px] sm:p-6" @click.self="!loading && (active = '')">
        <article class="max-h-[94vh] max-w-4xl w-full flex flex-col overflow-hidden border border-gray-200 rounded-lg bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800">
          <header class="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4 dark:border-gray-700 sm:px-6">
            <div class="min-w-0 flex items-center gap-3">
              <img v-if="moduleImages[active]" :src="`/game-config/module_icons/${moduleImages[active]}`" alt="" class="h-11 w-11 shrink-0 rounded-lg bg-gray-100 object-contain p-1.5 dark:bg-gray-700">
              <span v-else class="inline-grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-gray-100 text-xl dark:bg-gray-700"><span :class="activeInfo.icon" /></span>
              <div class="min-w-0">
                <h3 class="text-lg text-gray-900 font-semibold dark:text-gray-100">
                  {{ activeInfo.title }}
                </h3>
                <p class="mt-1 text-sm text-gray-500">
                  {{ activeInfo.description }}
                </p>
              </div>
            </div>
            <button aria-label="关闭配置" :disabled="loading" class="rounded-lg p-2 text-gray-400 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-700" @click="active = ''">
              <span class="i-carbon-close text-xl" />
            </button>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            <p v-if="error" class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300" role="alert">
              {{ error }}
            </p>
            <div v-if="options.some(o => o.module === active)" class="space-y-5">
              <section v-if="active === 'activity' && data?.capabilities?.claimTask" class="border border-gray-100 rounded-lg bg-gray-50/70 p-4 dark:border-gray-700 dark:bg-gray-900/25">
                <h4 class="mb-3 text-sm font-medium">
                  日常任务
                </h4>
                <BaseSwitch v-model="draft.autoClaimTasks" label="自动领取每日、成长任务奖励" :disabled="loading" />
              </section>
              <section class="border border-gray-100 rounded-lg bg-gray-50/70 p-4 dark:border-gray-700 dark:bg-gray-900/25">
                <h4 class="mb-3 flex items-center gap-2 text-sm font-medium">
                  <span :class="activeInfo.icon" />{{ active === 'merchant' ? '允许使用的货币' : active === 'friends' ? '好友互动' : '基础功能' }}
                </h4>
                <div class="grid gap-3 sm:grid-cols-2">
                  <div v-for="option in options.filter(o => o.module === active && o.key !== 'autoClaimTasks')" :key="option.key" class="min-w-0">
                    <BaseSwitch v-model="draft[option.key]" :label="option.label" :disabled="loading" />
                  </div>
                </div>
              </section>
              <section v-if="active === 'husbandry'" class="border border-gray-100 rounded-lg p-4 space-y-4 dark:border-gray-700">
                <h3 class="text-lg font-bold">
                  养殖策略与巡查频率
                </h3>
                <BaseSelect v-model="policy.husbandryStrategy" label="第一策略" :options="husbandryOptions" :disabled="loading" />
                <BaseSelect v-if="policy.husbandryStrategy === 'bag_priority'" v-model="policy.husbandryFallbackStrategy" label="第二策略" :options="husbandryFallbackOptions" :disabled="loading" />
                <p class="text-xs text-gray-500">
                  牧场幼崽优先使用背包中适合当前栏舍的幼崽，耗尽后按第二策略购买；其他策略从已解锁的金券幼崽中选择，购买后直接入栏；基础经验与产值按官方配置估算，不计增益、变异和饲料中断。
                </p>
                <div class="grid gap-3 sm:grid-cols-2">
                  <BaseInput v-model.number="policy.farmMin" label="牧场巡查最小（秒）" type="number" min="1" :disabled="loading" />
                  <BaseInput v-model.number="policy.farmMax" label="牧场巡查最大（秒）" type="number" min="1" :disabled="loading" />
                </div>
              </section>
              <section v-if="active === 'feed'" class="border border-gray-100 rounded-lg p-4 space-y-3 dark:border-gray-700">
                <div class="grid gap-3 sm:grid-cols-2">
                  <BaseSelect v-model="policy.canStrategy" label="罐头使用策略" :options="canOptions" :disabled="loading" />
                  <BaseInput v-if="['smart', 'smart_only', 'smart_normal'].includes(policy.canStrategy)" v-model.number="policy.smartSeconds" label="快成熟判定秒数" type="number" min="30" max="3600" :disabled="loading" />
                </div>
                <div class="grid gap-3 sm:grid-cols-2">
                  <BaseInput v-model.number="policy.feedThresholdPercent" label="牧草阈值（占容量 %）" type="number" min="0" max="100" :disabled="loading" />
                  <BaseInput v-model.number="policy.feedReserveCount" label="牧草保留量（不投入）" type="number" min="0" max="999999" :disabled="loading" />
                </div>
                <p class="text-xs text-gray-500">
                  牧草机存量低于容量百分比阈值时补满到容量（自己与好友的牧草机同一规则），0 表示关闭阈值、沿用旧的固定数量目标；保留量从仓库牧草中扣除，不参与补草。
                </p>
                <BaseSwitch v-model="policy.addFeedUseGold" label="自己的牧草机：牧草不足时用金券补满（60 金券/单位）" :disabled="loading" />
                <p class="text-xs text-gray-500">
                  {{ policy.addFeedUseGold ? '补草时仓库牧草优先消耗，不足部分按 60 金券/单位补到容量，并至少保留金券保留量。' : '只用仓库里的牧草补自己的牧草机；仓库牧草不足时跳过，不花货币。' }}
                </p>
              </section>
              <section v-if="active === 'friends'" class="border border-gray-100 rounded-lg p-4 space-y-3 dark:border-gray-700">
                <div class="grid gap-3 sm:grid-cols-2">
                  <BaseInput v-model.number="policy.helpMin" label="帮助巡查最小（秒）" type="number" min="1" :disabled="loading" />
                  <BaseInput v-model.number="policy.helpMax" label="帮助巡查最大（秒）" type="number" min="1" :disabled="loading" />
                </div>
                <BaseSwitch v-model="policy.quietEnabled" label="启用静默时段" :disabled="loading" />
                <div v-if="policy.quietEnabled" class="grid gap-3 sm:grid-cols-2">
                  <BaseInput v-model="policy.quietStart" label="开始时间（北京时间）" type="time" :disabled="loading" />
                  <BaseInput v-model="policy.quietEnd" label="结束时间（北京时间）" type="time" :disabled="loading" />
                </div>
                <div v-if="draft.autoFriendFeed" class="border-t border-gray-100 pt-3 dark:border-gray-700">
                  <div class="mb-2 flex items-center justify-between gap-2">
                    <span class="text-sm font-medium">只给这些好友加牧草</span>
                    <div class="flex shrink-0 items-center gap-2 text-xs text-gray-500">
                      <span>{{ feedFriendCount }} 位已选</span>
                      <button v-if="feedFriendCount" type="button" class="text-primary-600 hover:underline disabled:opacity-50 dark:text-primary-400" :disabled="loading" @click="clearFeedFriends">
                        清空
                      </button>
                    </div>
                  </div>
                  <p class="mb-2 text-xs text-gray-500">
                    {{ policy.feedFriendUseGold ? '开启金券补满后，按 60 金券/单位把牧草机补到容量，不动仓库牧草，并至少保留 1 万金券。' : '不选任何好友不会给任何人加草；只用仓库里的牧草，不花货币。' }}
                  </p>
                  <BaseSwitch v-model="policy.feedFriendUseGold" label="牧草不足时用金券补满（60 金券/单位）" :disabled="loading" />
                  <BaseInput v-model="feedFriendQuery" class="mb-2 mt-3" placeholder="搜索好友昵称或 GID" clearable :disabled="loading" />
                  <div class="max-h-56 divide-y divide-gray-100 overflow-y-auto border border-gray-100 rounded-lg dark:divide-gray-700 dark:border-gray-700">
                    <label v-for="friend in feedFriendList" :key="friend.gid" class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700/40">
                      <input type="checkbox" class="h-4 w-4 shrink-0" :checked="(policy.feedFriendGids || []).includes(friend.gid)" :disabled="loading" @change="toggleFeedFriend(friend.gid)">
                      <span class="min-w-0 flex-1 truncate">{{ friend.name || friend.gid }}</span>
                      <span class="shrink-0 text-xs text-gray-400">{{ friend.gid }}</span>
                    </label>
                    <p v-if="!feedFriendList.length" class="px-3 py-4 text-center text-xs text-gray-500">
                      {{ friendsError || (friendsLoading ? '正在读取好友列表…' : feedFriendQuery.trim() ? '没有匹配的好友' : '暂无牧场好友') }}
                    </p>
                  </div>
                  <p v-if="feedFriendQuery.trim() && feedFriendList.length" class="mt-1 text-xs text-gray-500">
                    匹配到 {{ feedFriendList.length }} 位好友
                  </p>
                </div>
              </section>
              <section v-if="active === 'steal'" class="border border-gray-100 rounded-lg bg-gray-50/70 p-4 dark:border-gray-700 dark:bg-gray-900/25">
                <h4 class="mb-2 text-sm font-medium">
                  巡查节奏说明
                </h4>
                <p class="text-xs text-gray-500">
                  根据已知好友动物的产出时间自动安排巡查，并轮转校准未知状态，无需设置固定偷取间隔。
                </p>
              </section>
              <p class="text-xs text-gray-500">
                仅对已启动账号执行；不使用未开放的付费资源。
              </p><div class="flex gap-2">
                <BaseButton :loading="loading" @click="save">
                  <span class="i-carbon-save mr-1" />保存
                </BaseButton><BaseButton variant="secondary" :disabled="loading" @click="active = ''">
                  取消
                </BaseButton>
              </div>
            </div><div v-else class="mt-4 space-y-3">
              <p class="text-sm text-gray-500">
                该模块自动化暂不可用。
              </p><BaseButton variant="secondary" @click="active = ''">
                返回
              </BaseButton>
            </div>
          </div>
        </article>
      </div>
    </Teleport>
    <div v-if="account.currentAccountId" class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <article v-for="module in modules" :key="module.key" class="group min-h-[184px] flex flex-col border border-gray-200 rounded-lg bg-white p-4 transition dark:border-gray-700 hover:border-[var(--theme-primary)] dark:bg-gray-800 hover:shadow-sm">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex items-center gap-3">
            <img v-if="moduleImages[module.key]" :src="`/game-config/module_icons/${moduleImages[module.key]}`" alt="" class="h-10 w-10 shrink-0 rounded-lg bg-gray-100 object-contain p-1.5 dark:bg-gray-700">
            <span v-else class="inline-grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-gray-100 text-xl dark:bg-gray-700"><span :class="module.icon" /></span>
            <div class="min-w-0">
              <h4 class="text-gray-900 font-semibold dark:text-gray-100">
                {{ module.title }}
              </h4>
              <p class="mt-0.5 text-xs text-gray-500">
                {{ module.description }}
              </p>
            </div>
          </div>
          <BaseSwitch :aria-label="`${module.title}自动化`" :model-value="enabledCount(module.key) > 0" :disabled="loading || !data" @update:model-value="toggleModule(module.key, !!$event)" />
        </div>
        <div class="mt-4 min-h-[56px] flex flex-wrap content-start gap-2">
          <span v-for="option in moduleOptions(module.key).filter(o => data?.[o.key])" :key="option.key" class="max-w-full rounded-md bg-gray-50 px-2.5 py-1 text-xs text-gray-600 dark:bg-gray-900/40 dark:text-gray-300">{{ option.label }}</span>
          <span v-if="!enabledCount(module.key)" class="rounded-md bg-gray-50 px-2.5 py-1 text-xs text-gray-500 dark:bg-gray-900/40">{{ loading && !data ? '读取配置中…' : moduleOptions(module.key).length ? '未开启动作' : '暂不可用' }}</span>
        </div>
        <div class="mt-auto flex items-center justify-between pt-4">
          <span class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <span class="h-2 w-2 rounded-full" :class="enabledCount(module.key) ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'" />
            {{ enabledCount(module.key) ? `${enabledCount(module.key)} 项已开启` : '未开启' }}
          </span>
          <BaseButton variant="secondary" size="sm" :disabled="loading || !data" @click="edit(module.key)">
            配置
          </BaseButton>
        </div>
      </article>
    </div>
  </section>
</template>
