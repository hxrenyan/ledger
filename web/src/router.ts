import { createRouter, createWebHistory } from 'vue-router'
import { getAdminToken } from './adminApi.ts'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/admin/login', component: () => import('./pages/admin/AdminLogin.vue') },
    { path: '/admin', component: () => import('./pages/admin/AdminHome.vue') },
    {
      path: '/tools',
      component: () => import('./pages/tools/ToolsShell.vue'),
      children: [
        { path: '', component: () => import('./pages/tools/ToolList.vue') },
        { path: 'contacts', component: () => import('./pages/tools/ContactsPage.vue') },
        { path: 'contacts/:id', component: () => import('./pages/tools/ContactForm.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/admin' },
  ],
})

router.beforeEach((to) => {
  if (to.path === '/admin/login' || to.path.startsWith('/tools')) return true
  if (!getAdminToken()) return '/admin/login'
  return true
})
