<script setup lang="ts">
/**
 * 小程序底部「工具」用原生页还是内嵌 H5。
 * 默认原生。保存后用户下次进入这一栏生效，不用发小程序。
 */
import { onMounted, ref } from 'vue'
import { adminApi } from '../../adminApi.ts'

type ToolsMode = 'native' | 'h5'

const mode = ref<ToolsMode>('native')
const err = ref('')
const msg = ref('')
const busy = ref(false)

async function load() {
  try {
    const data = await adminApi<{ mode: ToolsMode }>('/api/v1/admin/tools')
    mode.value = data.mode === 'h5' ? 'h5' : 'native'
    err.value = ''
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  }
}

async function save(next: ToolsMode) {
  if (busy.value || mode.value === next) return
  err.value = ''
  msg.value = ''
  busy.value = true
  try {
    const data = await adminApi<{ mode: ToolsMode }>('/api/v1/admin/tools', {
      method: 'PUT',
      body: JSON.stringify({ mode: next }),
    })
    mode.value = data.mode
    msg.value = data.mode === 'h5' ? '已切到 H5。用户下次进入「工具」会打开网页。' : '已切回原生。用户下次进入「工具」看到联系人列表。'
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busy.value = false
  }
}

onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <div class="admin-config-page">
    <div class="admin-config-title">
      <div>
        <h2>工具页</h2>
        <p class="muted">底部「工具」用哪一套。没配过就是原生。改完不用发版，用户下次点进这一栏生效。网页打不开时，小程序会自己退回原生列表。</p>
      </div>
      <span class="admin-status" :class="mode === 'h5' ? 'on' : 'off'">{{ mode === 'h5' ? 'H5' : '原生' }}</span>
    </div>
    <div class="admin-config-block">
      <div class="admin-seg" aria-label="工具页模式">
        <button type="button" :class="{ on: mode === 'native' }" :disabled="busy" @click="save('native')">原生</button>
        <button type="button" :class="{ on: mode === 'h5' }" :disabled="busy" @click="save('h5')">H5</button>
      </div>
      <p class="admin-hint">提审时保持原生。切到 H5 后，这一栏加载网页版工具；个人主体若没配业务域名，体验版上网页可能是空白，空白会退回原生。</p>
    </div>
    <p v-if="err" class="err admin-alert">{{ err }}</p>
    <p v-if="msg" class="admin-success">{{ msg }}</p>
  </div>
</template>
