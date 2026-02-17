import { createRouter, createWebHistory } from 'vue-router'
import AuthPage from '@/pages/AuthPage.vue'
import LobbyPage from '@/pages/LobbyPage.vue'
import RoomPage from '@/pages/RoomPage.vue'
import ReplaysPage from '@/pages/ReplaysPage.vue'
import ReplayDetailPage from '@/pages/ReplayDetailPage.vue'
import AdminUsersPage from '@/pages/AdminUsersPage.vue'
import { useSessionStore } from '@/stores/session'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/lobby' },
    { path: '/auth', name: 'auth', component: AuthPage },
    { path: '/lobby', name: 'lobby', component: LobbyPage },
    { path: '/room/:roomId', name: 'room', component: RoomPage },
    { path: '/replays', name: 'replays', component: ReplaysPage },
    { path: '/replays/:replayId', name: 'replayDetail', component: ReplayDetailPage },
    { path: '/admin/users', name: 'adminUsers', component: AdminUsersPage },
  ],
})

router.beforeEach(async (to) => {
  const session = useSessionStore()
  if (!session.isInitialized) await session.init()
  if (to.path === '/auth') return true
  if (!session.token) return { path: '/auth', replace: true }
  return true
})

export default router
