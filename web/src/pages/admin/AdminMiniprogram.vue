<script setup lang="ts">
/**
 * 小程序「关于记账」文案，以及正式版最低可用版本。
 * 保存后下次打开关于、或下次回到前台时生效，不用发版。
 */
import { onMounted, ref } from 'vue'
import { adminApi } from '../../adminApi.ts'

type ClientConfig = {
  about_title: string
  about_body: string
  min_version: string
  update_message: string
}

const aboutTitle = ref('记账')
const aboutBody = ref('')
const minVersion = ref('')
const updateMessage = ref('')
const err = ref('')
const msg = ref('')
const busy = ref(false)

function apply(data: ClientConfig) {
  aboutTitle.value = data.about_title
  aboutBody.value = data.about_body
  minVersion.value = data.min_version
  updateMessage.value = data.update_message
}

async function load() {
  try {
    apply(await adminApi<ClientConfig>('/api/v1/admin/miniprogram'))
    err.value = ''
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  }
}

async function save() {
  if (busy.value) return
  err.value = ''
  msg.value = ''
  busy.value = true
  try {
    apply(
      await adminApi<ClientConfig>('/api/v1/admin/miniprogram', {
        method: 'PUT',
        body: JSON.stringify({
          about_title: aboutTitle.value,
          about_body: aboutBody.value,
          min_version: minVersion.value,
          update_message: updateMessage.value,
        }),
      }),
    )
    msg.value = minVersion.value.trim()
      ? `已保存。正式版低于 ${minVersion.value.trim()} 的用户会被要求更新。`
      : '已保存。关于文案下次打开即生效，当前不强制更新。'
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
        <h2>小程序</h2>
        <p class="muted">「我的 → 关于记账」的标题和正文。已经上线的小程序仍显示包里的旧文案；这一版发出去之后，再改文字不用发版。最低版本留空则不限制；填了之后，正式版低于这个号的用户必须更新才能继续用。</p>
      </div>
      <span class="admin-status" :class="minVersion.trim() ? 'on' : 'off'">{{ minVersion.trim() ? minVersion.trim() : '不限制' }}</span>
    </div>
    <div class="admin-config-block">
      <label class="field">
        <span>关于标题</span>
        <input v-model="aboutTitle" maxlength="20" placeholder="记账" />
      </label>
      <label class="field">
        <span>关于正文</span>
        <textarea v-model="aboutBody" maxlength="400" rows="5" placeholder="打开关于时看到的说明"></textarea>
      </label>
      <label class="field">
        <span>最低版本</span>
        <input v-model="minVersion" maxlength="16" placeholder="例如 1.2.0，留空不强制" />
      </label>
      <label class="field">
        <span>更新提示</span>
        <input v-model="updateMessage" maxlength="80" placeholder="当前版本已停用，请更新后继续使用。" />
      </label>
      <p class="admin-hint">版本号按点分段比较，1.2 和 1.2.0 相同。只拦正式版；开发版和体验版版本号经常是空的，不拦截，避免调试进不去。新版本下载好后会直接重新进入，不用再点确认。</p>
    </div>
    <p v-if="err" class="err admin-alert">{{ err }}</p>
    <p v-if="msg" class="admin-success">{{ msg }}</p>
    <div class="admin-savebar">
      <span class="muted">新版小程序里，打开关于即可看到</span>
      <div class="admin-actions-inline">
        <button class="btn" type="button" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
      </div>
    </div>
  </div>
</template>
