import {
  BarChart3,
  Bell,
  BookText,
  Building2,
  FileText,
  Gauge,
  HandCoins,
  LayoutDashboard,
  Megaphone,
  ScrollText,
  Settings,
  SlidersHorizontal,
  UserCog,
  UserRound,
  Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  label: string
  icon: LucideIcon
  /** Route path. Omitted → feature not yet implemented (shows disabled). */
  to?: string
  /** Development phase that delivers this screen (for disabled items). */
  phase?: number
}

/** Admin navigation (spec §61). Items unlock as their phase is delivered. */
export const ADMIN_NAV: Array<NavItem> = [
  { label: 'Dashboard', icon: LayoutDashboard, to: '/admin' },
  { label: 'Clients', icon: Building2, to: '/admin/clients' },
  { label: 'Ad Accounts', icon: Megaphone, to: '/admin/ad-accounts' },
  { label: 'Limit Requests', icon: Gauge, to: '/admin/limit-requests' },
  { label: 'Payments', icon: Wallet, to: '/admin/payments' },
  { label: 'Payment Requests', icon: HandCoins, to: '/admin/payment-requests' },
  { label: 'Ledger', icon: BookText, to: '/admin/ledger' },
  { label: 'Adjustments', icon: SlidersHorizontal, to: '/admin/adjustments' },
  { label: 'Reports', icon: BarChart3, to: '/admin/reports' },
  { label: 'Audit Log', icon: ScrollText, to: '/admin/audit' },
  { label: 'Users', icon: UserCog, to: '/admin/users' },
  { label: 'Settings', icon: Settings, to: '/admin/settings' },
]

/** Client portal navigation (spec §61). */
export const CLIENT_NAV: Array<NavItem> = [
  { label: 'Dashboard', icon: LayoutDashboard, to: '/portal' },
  { label: 'My Ad Accounts', icon: Megaphone, to: '/portal/ad-accounts' },
  { label: 'Limit Requests', icon: Gauge, to: '/portal/limit-requests' },
  { label: 'Due & Payments', icon: Wallet, to: '/portal/due' },
  { label: 'Payment Requests', icon: HandCoins, to: '/portal/payment-requests' },
  { label: 'Statement', icon: FileText, to: '/portal/statement' },
  { label: 'Notifications', icon: Bell, to: '/portal/notifications' },
  { label: 'Profile', icon: UserRound, to: '/portal/profile' },
]
