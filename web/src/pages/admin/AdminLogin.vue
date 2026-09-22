<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { adminApi, setAdminToken } from '../../adminApi.ts'

const router = useRouter()
const password = ref('')
const err = ref('')

async function submit() {
  err.value = ''
  try {
    const body = await adminApi<{ token: string }>('/api/v1/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: password.value }),
    })
    setAdminToken(body.token)
    router.replace('/admin')
  } catch (e) {
    err.value = e instanceof Error ? e.message : '登录失败'
  }
}
</script>

<template>
  <div class="page" style="padding-top: 64px">
    <h1>管理后台</h1>
    <p class="muted" style="margin-top:-8px;margin-bottom:20px">使用 ADMIN_TOKEN，与用户账本分离</p>
    <div class="card">
      <form @submit.prevent="submit">
        <label class="field"><span>管理员口令</span><input v-model="password" type="password" autocomplete="current-password" /></label>
        <p v-if="err" class="err">{{ err }}</p>
        <button class="btn" type="submit">登录</button>
      </form>
    </div>
  </div>
</template>
