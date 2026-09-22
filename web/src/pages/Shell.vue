<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, type SessionBody } from '../api.ts'
import { useSession } from '../stores/session.ts'

const route = useRoute()
const router = useRouter()
const session = useSession()
const addOpen = ref(false)

watch(() => route.path, () => {
  addOpen.value = false
})

function goAdd(path: string) {
  addOpen.value = false
  router.push(path)
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
      <button class="nav-plus" type="button" @click="addOpen = true">+</button>
      <router-link to="/accounts" :class="{ on: route.path.startsWith('/accounts') }">资产</router-link>
      <router-link to="/me" :class="{ on: route.path.startsWith('/me') }">我的</router-link>
    </nav>
    <div v-if="addOpen" class="sheet-mask" @click="addOpen = false">
      <div class="sheet" @click.stop>
        <button class="btn" type="button" @click="goAdd('/tx/new')">记一笔</button>
        <button class="btn ghost" type="button" @click="goAdd('/speak')">语音录入</button>
        <button class="btn ghost" type="button" @click="addOpen = false">取消</button>
      </div>
    </div>
  </div>
</template>
