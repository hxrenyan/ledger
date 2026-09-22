<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, type SessionBody } from '../api.ts'
import { useSession } from '../stores/session.ts'

const router = useRouter()
const session = useSession()
const mode = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const nickname = ref('')
const err = ref('')
const loading = ref(false)

async function submit() {
  err.value = ''
  loading.value = true
  try {
    const path = mode.value === 'login' ? '/api/v1/auth/login' : '/api/v1/auth/register'
    const body = await api<SessionBody>(path, {
      method: 'POST',
      body: JSON.stringify({
        username: username.value,
        password: password.value,
        nickname: nickname.value || undefined,
      }),
    })
    session.apply(body)
    router.replace('/')
  } catch (e) {
    err.value = e instanceof Error ? e.message : '失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page" style="padding-top: 64px">
    <h1>记账</h1>
    <p class="muted" style="margin-top: -8px; margin-bottom: 20px">一人一号，数据在你自己的账本里</p>
    <div class="tabs">
      <button :class="{ on: mode === 'login' }" @click="mode = 'login'">登录</button>
      <button :class="{ on: mode === 'register' }" @click="mode = 'register'">注册</button>
    </div>
    <div class="card">
      <label class="field"><span>用户名</span><input v-model="username" autocomplete="username" /></label>
      <label class="field"><span>密码</span><input v-model="password" type="password" autocomplete="current-password" /></label>
      <label v-if="mode === 'register'" class="field"><span>昵称（可选）</span><input v-model="nickname" /></label>
      <p v-if="err" class="err">{{ err }}</p>
      <button class="btn" :disabled="loading" @click="submit">{{ mode === 'login' ? '登录' : '创建账号' }}</button>
    </div>
  </div>
</template>
