import { createRouter, createWebHistory } from 'vue-router'
import { getAdminToken } from './adminApi.ts'
import { useSession } from './stores/session.ts'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./pages/Login.vue') },
    { path: '/admin/login', component: () => import('./pages/admin/AdminLogin.vue') },
    { path: '/admin', component: () => import('./pages/admin/AdminHome.vue') },
    {
      path: '/',
      component: () => import('./pages/Shell.vue'),
      children: [
        { path: '', component: () => import('./pages/Home.vue') },
        { path: 'tx/new', component: () => import('./pages/TxForm.vue') },
        { path: 'tx/:id', component: () => import('./pages/TxForm.vue') },
        { path: 'accounts', component: () => import('./pages/Accounts.vue') },
        { path: 'categories', component: () => import('./pages/Categories.vue') },
        { path: 'budgets', component: () => import('./pages/Budgets.vue') },
        { path: 'favors', component: () => import('./pages/Favors.vue') },
        { path: 'favors/people', component: () => import('./pages/Contacts.vue') },
        { path: 'favors/new', component: () => import('./pages/GiftForm.vue') },
        { path: 'favors/gift/:id', component: () => import('./pages/GiftForm.vue') },
        { path: 'favors/person/:id', component: () => import('./pages/FavorPerson.vue') },
        { path: 'recurring', component: () => import('./pages/Recurring.vue') },
        { path: 'speak', component: () => import('./pages/Speak.vue') },
        { path: 'import', component: () => import('./pages/Import.vue') },
        { path: 'me', component: () => import('./pages/Settings.vue') },
      ],
    },
  ],
})

router.beforeEach((to) => {
  if (to.path.startsWith('/admin')) {
    if (to.path === '/admin/login') return true
    if (!getAdminToken()) return '/admin/login'
    return true
  }
  const session = useSession()
  if (to.path !== '/login' && !session.token) return '/login'
  if (to.path === '/login' && session.token) return '/'
})
