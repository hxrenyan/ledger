/**
 * 跨组件的「数据变了」通知。
 *
 * 底部加号浮层里记完账后，当前页面（明细 / 人情 / 某人往来）需要重新拉数据；
 * 页面在 setup 里调用 onDataChange(load)，组件销毁时自动注销。
 */
import { onScopeDispose } from 'vue'

const handlers = new Set<() => void>()

export function onDataChange(fn: () => void) {
  handlers.add(fn)
  onScopeDispose(() => handlers.delete(fn))
}

export function notifyDataChange() {
  for (const fn of [...handlers]) fn()
}
