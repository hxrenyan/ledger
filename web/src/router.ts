import { createRouter, createWebHistory } from 'vue-router'
import { getAdminToken } from './adminApi.ts'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/admin/login', component: () => import('./pages/admin/AdminLogin.vue') },
    { path: '/admin', component: () => import('./pages/admin/AdminHome.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/admin' },
  ],
})

router.beforeEach((to) => {
  if (to.path === '/admin/login') return true
  if (!getAdminToken()) return '/admin/login'
  return true
})
