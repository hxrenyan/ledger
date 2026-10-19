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
        { path: 'contacts/:contactId/records', component: () => import('./pages/tools/FavorRecords.vue') },
        { path: 'contacts/:contactId/gifts/new', component: () => import('./pages/tools/GiftForm.vue') },
        { path: 'gifts/:giftId', component: () => import('./pages/tools/GiftForm.vue') },
        { path: 'contacts/:id', component: () => import('./pages/tools/ContactForm.vue') },
        { path: 'calendar', component: () => import('./pages/tools/CalendarPage.vue') },
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
