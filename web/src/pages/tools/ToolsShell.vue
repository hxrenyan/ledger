<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { exchangeHandoff, hasSession } from '../../tools/session.ts'

const route = useRoute()
const router = useRouter()
const ready = ref(false)
const error = ref('')

onMounted(async () => {
  const code = typeof route.query.handoff === 'string' ? route.query.handoff : ''
  if (code) {
    try {
      await exchangeHandoff(code)
      await router.replace({ path: route.path, query: {} })
    } catch (err) {
      error.value = err instanceof Error ? err.message : '登录失败'
      ready.value = true
      return
    }
  }
  if (!hasSession()) error.value = '请从小程序的「工具」进入'
  ready.value = true
})
</script>

<template>
  <div class="tools-app">
    <p v-if="!ready" class="muted">打开中…</p>
    <p v-else-if="error" class="muted">{{ error }}</p>
    <router-view v-else />
  </div>
</template>

<style scoped>
.tools-app {
  max-width: 480px;
  margin: 0 auto;
  min-height: 100%;
  padding: max(16px, env(safe-area-inset-top)) 16px calc(24px + env(safe-area-inset-bottom));
}
</style>
