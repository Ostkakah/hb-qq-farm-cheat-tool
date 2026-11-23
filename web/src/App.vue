<script setup lang="ts">
import type { Theme } from '@/stores/app'
import { onMounted, onUnmounted } from 'vue'
import { RouterView } from 'vue-router'
import ToastContainer from '@/components/ToastContainer.vue'
import { startViewportGlass, stopViewportGlass } from '@/composables/viewport-glass'
import { useAppStore } from '@/stores/app'
import { useUserStore } from '@/stores/user'

const appStore = useAppStore()
const userStore = useUserStore()

// 立即应用保存的主题（在组件挂载前）
const savedTheme = localStorage.getItem('ui_theme') as Theme
if (savedTheme && appStore.themes[savedTheme]) {
  appStore.applyTheme(savedTheme)
}

// 玻璃渲染模式（在首次绘制前确定，避免闪一下再变）
//   默认：卡片按需懒挂 backdrop-filter，只处理视口内的少数几个
//   flat：完全不建 backdrop root，改为背景整体轻微柔化
// 切换：?glass=flat / ?glass=on，选择记在 localStorage 里，换页、刷新都不丢。
try {
  const glassParam = new URLSearchParams(window.location.search).get('glass')
  if (glassParam === 'flat' || glassParam === 'on')
    localStorage.setItem('glass_mode', glassParam)
  if (localStorage.getItem('glass_mode') === 'flat')
    document.documentElement.classList.add('glass-flat')
  else
    document.documentElement.classList.remove('glass-flat')
}
catch { /* 隐私模式下 localStorage 不可写，忽略 */ }

// iOS WebKit 修复：PWA/浏览器后台挂久了，WKWebView 恢复前台时部分 GPU 图块
// 纹理不重绘，表现为黑横线/黑竖线（tile 裂缝）。短暂后台用强制重绘修复，
// 后台超过 30 分钟直接整页刷新，最彻底。
let hiddenAt = 0
function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now()
    return
  }
  const awayMs = Date.now() - hiddenAt
  if (hiddenAt > 0 && awayMs > 30 * 60 * 1000) {
    location.reload()
    return
  }
  if (hiddenAt > 0 && awayMs > 3000) {
    forceRecomposite()
  }
  hiddenAt = 0
}

// 切换一次合成层属性，强制整页重新合成，把已失效的 GPU 图块重绘回来
function forceRecomposite() {
  const root = document.documentElement
  root.style.transform = 'translateZ(0)'
  requestAnimationFrame(() => {
    root.style.transform = ''
  })
}

// 长时间开着也可能慢慢累积出裂缝，定时静默重绘一次（无感知，不影响输入）
let repaintTimer: number | null = null

onMounted(() => {
  appStore.fetchTheme()
  // 刷新一次用户信息：账号额度、卡密状态可能已被管理员改过，
  // localStorage 里的旧值会一直生效，导致「添加账号」按钮莫名被禁用。
  if (userStore.isLoggedIn)
    void userStore.fetchUserInfo()
  startViewportGlass()
  document.addEventListener('visibilitychange', handleVisibilityChange)
  repaintTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible')
      forceRecomposite()
  }, 8 * 60 * 1000)
})

onUnmounted(() => {
  stopViewportGlass()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  if (repaintTimer !== null) {
    window.clearInterval(repaintTimer)
    repaintTimer = null
  }
})
</script>

<template>
  <div class="app-root h-screen w-screen overflow-hidden" :style="{ color: 'var(--theme-text)' }">
    <RouterView />
    <ToastContainer />
  </div>
</template>

<style>
/* Global styles */
body {
  margin: 0;
  font-family: 'DM Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: var(--app-bg);
  color: var(--theme-text);
  font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
}

/* Color theme variables - Dashboard Theme */
:root {
  --theme-bg: transparent;
  --theme-text: #2C3E50;
  --theme-primary: #2ECC71;
  --theme-secondary: #3498DB;
  --theme-gradient: linear-gradient(135deg, #2ECC71 0%, #3498DB 100%);
  --app-bg: transparent;
  --surface-1: rgba(255, 255, 255, 0.75);
  --surface-2: rgba(255, 255, 255, 0.6);
  --surface-3: rgba(255, 255, 255, 0.45);
  --surface-border: rgba(255, 255, 255, 0.5);
  --surface-border-strong: rgba(255, 255, 255, 0.6);
  --surface-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
  --surface-shadow-soft: 0 2px 12px rgba(0, 0, 0, 0.06);
  --muted-text: #7F8C8D;
  --input-bg: rgba(255, 255, 255, 0.88);
  --panel-glow: rgba(46, 204, 113, 0.08);
  /* 画布兜底色：主题背景为透明时，垫在背景图下方，避免出现纯白底 */
  --app-canvas: linear-gradient(180deg, #cfe8f9 0%, #edf7f9 48%, #fef9e8 55%, #eff8df 100%);
}

.dark {
  --app-bg: transparent;
  --surface-1: rgba(255, 255, 255, 0.08);
  --surface-2: rgba(255, 255, 255, 0.06);
  --surface-3: rgba(255, 255, 255, 0.04);
  --surface-border: rgba(255, 255, 255, 0.1);
  --surface-border-strong: rgba(255, 255, 255, 0.15);
  --surface-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
  --surface-shadow-soft: 0 2px 12px rgba(0, 0, 0, 0.2);
  --muted-text: #95A5A6;
  --input-bg: rgba(0, 0, 0, 0.3);
  --panel-glow: rgba(46, 204, 113, 0.06);
  --app-canvas: #0f172a;
}

.app-root {
  background: var(--app-bg);
}

/* SaaS surface system */
.bg-white {
  background-color: var(--surface-1) !important;
}

.dark .bg-gray-800,
.dark .bg-gray-900 {
  background-color: var(--surface-1) !important;
}

.bg-gray-50 {
  background-color: var(--surface-2) !important;
}

.dark .bg-gray-700 {
  background-color: var(--surface-3) !important;
}

/*
 * 卡片的 backdrop-filter 不写在这里，统一交给 .glass-on（见 style.css）。
 * 该 class 由 viewport-glass.ts 按视口可见性挂载，保证同时在场的 backdrop root
 * 只有一屏的量，避免滚动时几十张卡片一起做全屏采样把 GPU tile 挤爆。
 */
.ui-card {
  border: 1px solid var(--surface-border);
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 90%, rgba(34, 197, 94, 0.04) 10%), var(--surface-1));
  box-shadow: var(--surface-shadow-soft);
}

.ui-card-elevated {
  border: 1px solid var(--surface-border-strong);
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 86%, rgba(34, 197, 94, 0.06) 14%), var(--surface-1));
  box-shadow: var(--surface-shadow);
}

.ui-subtle-panel {
  border: 1px solid var(--surface-border);
  background: color-mix(in srgb, var(--surface-2) 80%, transparent);
}

.glass-panel {
  border: 1px solid var(--surface-border);
  background: color-mix(in srgb, var(--surface-1) 72%, transparent);
  box-shadow: var(--surface-shadow-soft);
}

.metric-card {
  position: relative;
  overflow: hidden;
}

.metric-card::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(135deg, var(--panel-glow), transparent 42%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.14), transparent 34%);
}

.metric-card > * {
  position: relative;
}

.shadow,
.shadow-sm,
.shadow-md {
  box-shadow: var(--surface-shadow-soft) !important;
}

/* Use CSS variables for theme colors */
.btn-primary {
  background: var(--theme-gradient);
  border-color: var(--theme-primary);
}

.btn-primary:hover {
  background: var(--theme-secondary);
}

.text-primary {
  color: var(--theme-primary);
}

.bg-primary {
  background-color: var(--theme-primary);
}

.border-primary {
  border-color: var(--theme-primary);
}

.bg-gradient-primary {
  background: var(--theme-gradient);
}

/* Scrollbar styling */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--theme-primary) 40%, #94a3b8);
  border-radius: 999px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--theme-secondary);
  opacity: 0.8;
}

/* Pastoral decorative floating leaves animation */
@keyframes float-leaf {
  0%, 100% {
    transform: translateY(0) rotate(0deg);
    opacity: 0.6;
  }
  50% {
    transform: translateY(-20px) rotate(15deg);
    opacity: 0.8;
  }
}

.pastoral-leaf {
  position: absolute;
  pointer-events: none;
  animation: float-leaf 6s ease-in-out infinite;
}

.pastoral-leaf:nth-child(2) {
  animation-delay: 2s;
  animation-duration: 8s;
}

.pastoral-leaf:nth-child(3) {
  animation-delay: 4s;
  animation-duration: 7s;
}
</style>
