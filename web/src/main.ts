import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { bridgeReady } from './bridge.ts'
import { router } from './router.ts'
import './style.css'

const pinia = createPinia()
const app = createApp(App).use(pinia).use(router)

// 先装 pinia 再握手：web-view 里要先用交接码换回会话，路由守卫才判得对，
// 否则会先闪一下 /login。普通浏览器里 bridgeReady 立刻 resolve，没有额外延迟。
bridgeReady().finally(() => app.mount('#app'))
