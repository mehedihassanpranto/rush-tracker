import {
  BarChart3,
  Bell,
  BookText,
  Building2,
  FileText,
  Gauge,
  HandCoins,
  Inbox,
  Landmark,
  LayoutDashboard,
  Megaphone,
  ScrollText,
  Settings,
  SlidersHorizontal,
  TrendingUp,
  UserCog,
  Users,
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
  { label: 'Dashboard', icon: LayoutDashboard, to: '/agency' },
  { label: 'Clients', icon: Building2, to: '/agency/clients' },
  { label: 'Ad Accounts', icon: Megaphone, to: '/agency/ad-accounts' },
  { label: 'Limit Requests', icon: Gauge, to: '/agency/limit-requests' },
  { label: 'Payments', icon: Wallet, to: '/agency/payments' },
  { label: 'Payment Requests', icon: HandCoins, to: '/agency/payment-requests' },
  { label: 'Ledger', icon: BookText, to: '/agency/ledger' },
  { label: 'Adjustments', icon: SlidersHorizontal, to: '/agency/adjustments' },
  { label: 'Reports', icon: BarChart3, to: '/agency/reports' },
  { label: 'Finance', icon: TrendingUp, to: '/agency/finance' },
  { label: 'Audit Log', icon: ScrollText, to: '/agency/audit' },
  { label: 'Users', icon: UserCog, to: '/agency/users' },
  { label: 'Settings', icon: Settings, to: '/agency/settings' },
]

/**
 * Platform owner's navigation — a separate entity from the agency app, not
 * a section of it. There is deliberately no cross-link in either direction:
 * a platform account manages subscriptions and never operates an agency,
 * and an agency account has no platform access at all.
 */
export const PLATFORM_NAV: Array<NavItem> = [
  { label: 'Organizations', icon: Building2, to: '/platform/organizations' },
  { label: 'Ad Account Pool', icon: Megaphone, to: '/platform/ad-accounts' },
  { label: 'Account Requests', icon: Inbox, to: '/platform/account-requests' },
  { label: 'Limit Requests', icon: Gauge, to: '/platform/limit-requests' },
  { label: 'Finance & Accounts', icon: Landmark, to: '/platform/finance' },
  { label: 'Settings', icon: Settings, to: '/platform/settings' },
]

/** Client portal navigation (spec §61). */
export const CLIENT_NAV: Array<NavItem> = [
  { label: 'Dashboard', icon: LayoutDashboard, to: '/client' },
  { label: 'My Ad Accounts', icon: Megaphone, to: '/client/ad-accounts' },
  { label: 'Limit Requests', icon: Gauge, to: '/client/limit-requests' },
  { label: 'Due & Payments', icon: Wallet, to: '/client/due' },
  { label: 'Payment Requests', icon: HandCoins, to: '/client/payment-requests' },
  { label: 'Statement', icon: FileText, to: '/client/statement' },
  { label: 'Team', icon: Users, to: '/client/team' },
  { label: 'Notifications', icon: Bell, to: '/client/notifications' },
  { label: 'Profile', icon: UserRound, to: '/client/profile' },
]
