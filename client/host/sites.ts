/** The Embed tab (admins): each site's domains, wording, offline behaviour and snippet. */

import { describeDomain } from '../../src/shared/domains'
import { boot, type Site } from './boot'
import { describe, els, text, toast } from './dom'
import { data } from './state'
import { api } from './api'

function snippetFor(site: Site): string {
  return `<script\n  src="${boot.baseUrl}/widget.js"\n  data-site="${site.id}"\n  data-position="${site.position}"\n  defer\n></script>`
}

async function siteRequest(path: string, init: RequestInit): Promise<Site> {
  return (await api<{ site: Site }>(path, init)).site
}

async function patchSite(id: string, patch: Partial<Pick<Site, 'enabled' | 'offlineMode'>> & { agentLabel?: string }): Promise<void> {
  try {
    upsertSite(await siteRequest(`/api/host/sites/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }))
    toast('Saved. Widgets pick it up within a minute.')
  } catch (error) {
    toast(describe(error), true)
  }
}

function upsertSite(site: Site): void {
  const index = data.sites.findIndex((s) => s.id === site.id)
  if (index >= 0) data.sites[index] = site
  else data.sites.push(site)
  data.sites.sort((a, b) => a.name.localeCompare(b.name))
  renderSites()
}

export function renderSites(): void {
  if (!els.sites) return
  if (data.sites.length === 0) {
    els.sites.replaceChildren(text('div', 'empty', 'No sites yet. Create one on the left.'))
    return
  }
  els.sites.replaceChildren(...data.sites.map(renderSiteCard))
}

function renderSiteCard(site: Site): HTMLElement {
  const card = document.createElement('section')
  card.className = `card stack site-card${site.enabled ? '' : ' disabled'}`

  const head = document.createElement('div')
  head.className = 'between'
  const title = document.createElement('div')
  title.className = 'row'
  title.append(text('h2', '', site.name), text('span', 'badge', site.id))
  const toggle = document.createElement('label')
  toggle.className = 'switch'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = site.enabled
  checkbox.onchange = () => void patchSite(site.id, { enabled: checkbox.checked })
  toggle.append(checkbox, document.createTextNode(site.enabled ? 'Enabled' : 'Disabled'))
  head.append(title, toggle)
  card.append(head)

  // Widget wording for this site.
  const wording = document.createElement('div')
  wording.className = 'two'
  const labelWrap = document.createElement('div')
  labelWrap.append(text('label', '', 'Name in the widget'))
  const label = document.createElement('input')
  label.type = 'text'
  label.maxLength = 40
  label.placeholder = 'Agent'
  label.value = site.agentLabel ?? ''
  label.setAttribute('aria-label', `Name shown in the widget on ${site.name}`)
  label.onchange = () => void patchSite(site.id, { agentLabel: label.value })
  labelWrap.append(label, text('div', 'tiny muted', 'Used as "… is live" and "Talk to …". Empty means "Agent".'))
  const modeWrap = document.createElement('div')
  modeWrap.append(text('label', '', 'When nobody is live'))
  const mode = document.createElement('select')
  mode.setAttribute('aria-label', `Offline behaviour on ${site.name}`)
  for (const [value, caption] of [['show', 'Show "offline" with a message form'], ['hide', 'Show nothing at all']] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = caption
    option.selected = site.offlineMode === value
    mode.append(option)
  }
  mode.onchange = () => void patchSite(site.id, { offlineMode: mode.value as 'show' | 'hide' })
  modeWrap.append(mode, text('div', 'tiny muted', 'A hidden widget still appears the moment an agent goes live.'))
  wording.append(labelWrap, modeWrap)
  card.append(wording)

  // Domains.
  card.append(text('label', '', 'Domains'))
  const chips = document.createElement('div')
  chips.className = 'chips'
  if (site.allowedDomains.length === 0) chips.append(text('span', 'site-error', 'No domains — the widget will refuse to load anywhere for this site.'))
  for (const domain of site.allowedDomains) {
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.title = describeDomain(domain)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '×'
    remove.setAttribute('aria-label', `Remove ${domain}`)
    remove.onclick = async () => {
      if (!confirm(`Remove ${domain} from ${site.name}? The widget will stop loading there within a minute.`)) return
      try {
        upsertSite(await siteRequest(`/api/host/sites/${site.id}/domains/${encodeURIComponent(domain)}`, { method: 'DELETE' }))
      } catch (error) {
        toast(describe(error), true)
      }
    }
    chip.append(text('span', '', domain), text('span', 'sub', '+ subdomains'), remove)
    chips.append(chip)
  }
  card.append(chips)

  const form = document.createElement('form')
  form.className = 'domain-form'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'example.com'
  input.setAttribute('aria-label', `Add a domain to ${site.name}`)
  input.autocomplete = 'off'
  const add = document.createElement('button')
  add.type = 'submit'
  add.className = 'btn-ghost'
  add.textContent = 'Add domain'
  const error = text('div', 'site-error hidden', '')
  form.onsubmit = async (event) => {
    event.preventDefault()
    error.classList.add('hidden')
    add.disabled = true
    try {
      upsertSite(await siteRequest(`/api/host/sites/${site.id}/domains`, { method: 'POST', body: JSON.stringify({ domain: input.value }) }))
      toast(`Added. Live on ${input.value.trim()} within a minute.`)
    } catch (err) {
      error.textContent = describe(err)
      error.classList.remove('hidden')
      add.disabled = false
    }
  }
  form.append(input, add)
  card.append(form, error)

  card.append(text('label', '', 'Snippet'))
  const pre = document.createElement('pre')
  pre.className = 'embed-snippet mono'
  pre.textContent = snippetFor(site)
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'btn-ghost'
  copy.textContent = 'Copy snippet'
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(snippetFor(site))
      toast('Snippet copied.')
    } catch {
      toast('Could not copy — select it manually.', true)
    }
  }
  card.append(pre, copy)
  return card
}

/** The "Add a site" form. Present only for admins. */
export function wireSiteForm(): void {
  if (!els.siteForm) return
  els.siteForm.onsubmit = async (event) => {
    event.preventDefault()
    const button = els.siteForm.querySelector('button')
    if (button) button.disabled = true
    try {
      const created = await siteRequest('/api/host/sites', { method: 'POST', body: JSON.stringify({ id: els.siteId.value, name: els.siteName.value }) })
      upsertSite(created)
      els.siteForm.reset()
      delete els.siteId.dataset.touched
      toast(`${created.name} created. Add its domain, then paste the snippet.`)
    } catch (error) {
      toast(describe(error), true)
    } finally {
      if (button) button.disabled = false
    }
  }
  els.siteName.oninput = () => {
    if (els.siteId.dataset.touched) return
    els.siteId.value = els.siteName.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  }
  els.siteId.oninput = () => {
    els.siteId.dataset.touched = '1'
  }
}
