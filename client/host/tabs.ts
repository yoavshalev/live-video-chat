/** The five tabs. The hash is the tab, so a reload lands where you were. */

import { isAdmin } from './boot'
import { refreshInbox } from './inbox'

export type Tab = 'live' | 'embed' | 'clip' | 'inbox' | 'agents'
const TABS: Tab[] = ['live', 'embed', 'clip', 'inbox', 'agents']

export function showTab(tab: Tab, pushHash = true): void {
  if (tab === 'embed' && !isAdmin) tab = 'live'
  for (const name of TABS) document.getElementById(`tab-${name}`)?.classList.toggle('hidden', name !== tab)
  for (const button of document.querySelectorAll<HTMLButtonElement>('.tab[data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab))
  }
  if (pushHash && location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`)
  if (tab === 'inbox') void refreshInbox()
}

export function wireTabs(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('.tab[data-tab]')) {
    button.onclick = () => showTab(button.dataset.tab as Tab)
  }
  window.addEventListener('hashchange', () => {
    const tab = location.hash.slice(1) as Tab
    if (TABS.includes(tab)) showTab(tab, false)
  })
  const initial = location.hash.slice(1) as Tab
  showTab(TABS.includes(initial) ? initial : 'live', false)
}
