<script setup lang="ts">
/**
 * 相机按钮 + 隐藏的文件选择。
 *
 * H5 没有 wx.chooseMedia，只能靠 input[type=file]；而这块有个容易踩的坑：
 * **选完必须把 input.value 清空**，否则第二次选同一个文件不会触发 change
 * （值没变），表现为「再点一次没反应」。集中到这里一处处理。
 *
 * 不写 capture 属性：写了会直接调起相机、跳过相册，而截图在相册里。
 */
import { ref } from 'vue'

const props = defineProps<{ disabled?: boolean; label?: string; size?: 'sm' | 'lg' }>()
const emit = defineEmits<{ picked: [File] }>()

const input = ref<HTMLInputElement | null>(null)

function open() {
  if (props.disabled) return
  input.value?.click()
}

function onChange(e: Event) {
  const el = e.target as HTMLInputElement
  const file = el.files?.[0] ?? null
  el.value = ''
  if (file) emit('picked', file)
}
</script>

<template>
  <button
    class="mic cam"
    :class="{ 'mic-sm': size !== 'lg' }"
    type="button"
    :disabled="disabled"
    :aria-label="label || '拍一张小票或支付截图'"
    @click="open"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 8.6A2.6 2.6 0 0 1 6.6 6h1.1l1-1.7a1 1 0 0 1 .86-.5h4.88a1 1 0 0 1 .86.5l1 1.7h1.1A2.6 2.6 0 0 1 20 8.6v7.8A2.6 2.6 0 0 1 17.4 19H6.6A2.6 2.6 0 0 1 4 16.4V8.6Z" />
      <circle cx="12" cy="12.6" r="3.1" />
    </svg>
  </button>
  <input ref="input" class="file-hidden" type="file" accept="image/*" @change="onChange" />
</template>
