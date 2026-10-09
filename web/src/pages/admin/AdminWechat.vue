<script setup lang="ts">
/**
 * 小程序微信登录凭证。AppSecret 只回显掩码，留空表示沿用已保存的值。
 * 保存后下一次登录即生效，不用改环境变量或重启。
 */
import { onMounted, ref } from 'vue'
import { adminApi } from '../../adminApi.ts'

const appId = ref('')
const appSecret = ref('')
const secretHint = ref('')
const configured = ref(false)
const err = ref('')
const msg = ref('')
const busy = ref(false)

async function load() {
  const data = await adminApi<{ app_id: string; secret_hint: string; configured: boolean }>('/api/v1/admin/wechat')
  appId.value = data.app_id
  secretHint.value = data.secret_hint
  configured.value = data.configured
  appSecret.value = ''
}

async function save() {
  err.value = ''
  msg.value = ''
  busy.value = true
  try {
    const data = await adminApi<{ app_id: string; secret_hint: string; configured: boolean }>('/api/v1/admin/wechat', {
      method: 'PUT',
      body: JSON.stringify({ app_id: appId.value.trim(), app_secret: appSecret.value.trim() }),
    })
    appId.value = data.app_id
    secretHint.value = data.secret_hint
    configured.value = data.configured
    appSecret.value = ''
    msg.value = '已保存。下次微信登录会使用这组凭证。'
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busy.value = false
  }
}

onMounted(() => load().catch((e) => { err.value = e instanceof Error ? e.message : '加载失败' }))
</script>

<template>
  <div class="admin-config-page">
    <div class="admin-config-title">
      <div>
        <h2>微信登录</h2>
        <p class="muted">小程序 AppID 和 AppSecret。保存后立即用于微信登录，不用重启，也不会写进小程序代码。</p>
      </div>
      <span class="admin-status" :class="configured ? 'on' : 'off'">{{ configured ? '已配置' : '未配置' }}</span>
    </div>
    <div class="admin-config-block">
      <label class="field">
        <span>AppID</span>
        <input v-model="appId" placeholder="wx 开头的 18 位 AppID" autocomplete="off" />
      </label>
      <label class="field">
        <span>AppSecret{{ secretHint ? `（已保存：${secretHint}，留空不改）` : '' }}</span>
        <input v-model="appSecret" type="password" autocomplete="off" :placeholder="secretHint ? '留空则不修改' : '微信公众平台里的 AppSecret'" />
      </label>
      <p class="admin-hint">这里没配齐时，仍使用服务器环境变量 WX_APPID / WX_SECRET。</p>
    </div>
    <p v-if="err" class="err admin-alert">{{ err }}</p>
    <p v-if="msg" class="admin-success">{{ msg }}</p>
    <div class="admin-savebar">
      <span class="muted">AppSecret 只保存在服务端</span>
      <button class="btn" type="button" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
    </div>
  </div>
</template>
