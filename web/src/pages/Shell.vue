<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { inMiniProgram, navTo, switchTab } from '../bridge.ts'
import VoiceSheet from '../components/VoiceSheet.vue'
import { api, type SessionBody } from '../api.ts'
import { notifyDataChange } from '../refresh.ts'
import { useSession } from '../stores/session.ts'
import type { VoiceScope } from '../voice.ts'

const route = useRoute()
const router = useRouter()
const session = useSession()

/** 加号浮层：标题标明记什么，按钮只选手写或语音；语音在本层展开，不跳页。 */
const addOpen = ref(false)
const voiceScope = ref<VoiceScope | null>(null)
const toast = ref('')
let toastTimer = 0

const inFavor = computed(() => route.path.startsWith('/favors'))
const personId = computed(() =>
  route.path.startsWith('/favors/person/') ? String(route.params.id ?? '') : '',
)

/**
 * 底部导航。
 *
 * 这四页在小程序里全是原生页（要 wx.login / 录音 / 拍照 / 选图），
 * 所以在 web-view 里点它们 = 把用户交回原生页面；普通浏览器里才是前端路由。
 * 这样网页版是「进去看一眼再退回来」的长尾页，不是和原生并行的一套壳——
 * 既是体验考虑，也避免被判成「纯网页套壳」。
 */
const navItems = [
  { label: '明细', to: '/', mini: '/pages/home/home', match: (p: string) => p === '/' },
  { label: '人情', to: '/favors', mini: '/pages/favors/favors', match: (p: string) => p.startsWith('/favors') },
  { label: '资产', to: '/accounts', mini: '/pages/assets/assets', match: (p: string) => p.startsWith('/accounts') },
  { label: '我的', to: '/me', mini: '/pages/me/me', match: (p: string) => p.startsWith('/me') },
]

function goNav(item: (typeof navItems)[number]) {
  if (inMiniProgram) {
    switchTab(item.mini)
    return
  }
  router.push(item.to)
}

watch(() => route.path, () => {
  addOpen.value = false
  voiceScope.value = null
})

function openAdd() {
  // 记账表单一律用原生页：要拍照存收据、要录音，网页在 web-view 里拿不到这些能力。
  if (inMiniProgram) {
    if (!inFavor.value) {
      navTo('/pages/tx-form/tx-form')
      return
    }
    navTo(personId.value ? `/pages/gift-form/gift-form?contact=${personId.value}` : '/pages/gift-form/gift-form')
    return
  }
  voiceScope.value = null
  addOpen.value = true
}

function close() {
  addOpen.value = false
  voiceScope.value = null
}

function writeManual() {
  close()
  if (!inFavor.value) {
    router.push('/tx/new')
    return
  }
  router.push(personId.value ? `/favors/new?contact=${personId.value}` : '/favors/new')
}

function openVoice() {
  voiceScope.value = inFavor.value ? 'favor' : 'tx'
}

function onVoiceDone(msg: string) {
  close()
  notifyDataChange()
  toast.value = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.value = ''
  }, 2400)
}

onMounted(async () => {
  if (!session.token) return
  try {
    const body = await api<SessionBody>('/api/v1/me')
    session.apply({ ...body, token: session.token })
  } catch {
    /* 401 由 api 处理 */
  }
})
</script>

<template>
  <div class="shell">
    <div class="shell-body">
      <router-view />
    </div>
    <nav class="nav">
      <template v-for="item in navItems.slice(0, 2)" :key="item.label">
        <a :href="item.to" :class="{ on: item.match(route.path) }" @click.prevent="goNav(item)">{{ item.label }}</a>
      </template>
      <button class="nav-plus" type="button" @click="openAdd">+</button>
      <template v-for="item in navItems.slice(2)" :key="item.label">
        <a :href="item.to" :class="{ on: item.match(route.path) }" @click.prevent="goNav(item)">{{ item.label }}</a>
      </template>
    </nav>

    <p v-if="toast" class="toast">{{ toast }}</p>

    <div v-if="addOpen" class="sheet-mask" @click="close">
      <div class="sheet" @click.stop>
        <template v-if="!voiceScope">
          <p class="add-title">{{ inFavor ? '记人情' : '记一笔' }}</p>
          <div class="add-pick">
            <button type="button" :aria-label="inFavor ? '手写记人情' : '手写记一笔'" @click="writeManual">
              <span class="add-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
                  <path d="m13.5 6.5 3 3" />
                </svg>
              </span>
              手写
            </button>
            <button type="button" :aria-label="inFavor ? '智能记人情' : '智能记一笔'" @click="openVoice">
              <span class="add-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z" />
                  <path d="M6 11a6 6 0 0 0 12 0M12 17v3" />
                </svg>
              </span>
              智能记账
            </button>
          </div>
          <button class="add-cancel" type="button" @click="close">取消</button>
        </template>
        <VoiceSheet v-else :scope="voiceScope" @close="close" @done="onVoiceDone" />
      </div>
    </div>
  </div>
</template>
