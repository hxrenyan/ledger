<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import VoiceSheet from '../components/VoiceSheet.vue'
import { api, type SessionBody } from '../api.ts'
import { notifyDataChange } from '../refresh.ts'
import { useSession } from '../stores/session.ts'
import type { VoiceScope } from '../voice.ts'

const route = useRoute()
const router = useRouter()
const session = useSession()

/** 加号浮层：先选「手写 / 语音」，语音在本层展开录音，不跳页。 */
const addOpen = ref(false)
const voiceScope = ref<VoiceScope | null>(null)
const toast = ref('')
let toastTimer = 0

const inFavor = computed(() => route.path.startsWith('/favors'))
const personId = computed(() =>
  route.path.startsWith('/favors/person/') ? String(route.params.id ?? '') : '',
)

watch(() => route.path, () => {
  addOpen.value = false
  voiceScope.value = null
})

function openAdd() {
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
      <router-link to="/" :class="{ on: route.path === '/' }">明细</router-link>
      <router-link to="/favors" :class="{ on: route.path.startsWith('/favors') }">人情</router-link>
      <button class="nav-plus" type="button" @click="openAdd">+</button>
      <router-link to="/accounts" :class="{ on: route.path.startsWith('/accounts') }">资产</router-link>
      <router-link to="/me" :class="{ on: route.path.startsWith('/me') }">我的</router-link>
    </nav>

    <p v-if="toast" class="toast">{{ toast }}</p>

    <div v-if="addOpen" class="sheet-mask" @click="close">
      <div class="sheet" @click.stop>
        <template v-if="!voiceScope">
          <button class="btn" type="button" @click="writeManual">
            {{ inFavor ? '手写记人情' : '手写记一笔' }}
          </button>
          <button class="btn ghost" type="button" @click="openVoice">
            {{ inFavor ? '语音记人情' : '语音记一笔' }}
          </button>
          <button class="btn ghost" type="button" @click="close">取消</button>
        </template>
        <VoiceSheet v-else :scope="voiceScope" @close="close" @done="onVoiceDone" />
      </div>
    </div>
  </div>
</template>
