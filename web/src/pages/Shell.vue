<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, type SessionBody } from '../api.ts'
import { useSession } from '../stores/session.ts'

const route = useRoute()
const router = useRouter()
const session = useSession()

function onPlus() {
  if (route.path.startsWith('/favors/person/') && typeof route.params.id === 'string') {
    router.push(`/favors/new?contact=${route.params.id}`)
    return
  }
  if (route.path.startsWith('/favors')) {
    router.push('/favors/new')
    return
  }
  router.push('/tx/new')
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
      <button class="nav-plus" type="button" @click="onPlus">+</button>
      <router-link to="/accounts" :class="{ on: route.path.startsWith('/accounts') }">资产</router-link>
      <router-link to="/me" :class="{ on: route.path.startsWith('/me') }">我的</router-link>
    </nav>
  </div>
</template>
