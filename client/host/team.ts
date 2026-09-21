/** The Agents tab: the team, roles and passwords (admins), and your own password. */

import { boot, isAdmin, type AgentSummary } from './boot'
import { $, describe, els, text, timeAgo, toast } from './dom'
import { data, live } from './state'
import { api } from './api'

function upsertAgent(agent: AgentSummary): void {
  const index = data.team.findIndex((a) => a.id === agent.id)
  if (index >= 0) data.team[index] = agent
  else data.team.push(agent)
  renderTeam()
}

export function renderTeam(): void {
  if (data.team.length === 0) {
    els.agentsList.replaceChildren(text('div', 'empty', 'No agents yet.'))
    return
  }
  els.agentsList.replaceChildren(
    ...data.team.map((agent) => {
      const row = document.createElement('div')
      row.className = `inbox-row${agent.enabled ? '' : ' disabled'}`
      const head = document.createElement('div')
      head.className = 'who'
      const status = live.agents.find((a) => a.id === agent.id)?.status ?? 'offline'
      head.append(
        text('span', 'name', agent.id === boot.me.agentId ? `${agent.name} (you)` : agent.name),
        text('span', 'badge', agent.role),
        text('span', `badge outcome ${status}`, status),
        ...(agent.enabled ? [] : [text('span', 'badge away', 'disabled')]),
        text('span', 'tiny muted', agent.email)
      )
      row.append(head)
      row.append(text('div', 'tiny muted', agent.lastLoginAt ? `Last signed in ${timeAgo(agent.lastLoginAt)}` : 'Never signed in'))

      if (isAdmin) {
        const actions = document.createElement('div')
        actions.className = 'row'
        const roleButton = document.createElement('button')
        roleButton.type = 'button'
        roleButton.className = 'btn-ghost'
        roleButton.textContent = agent.role === 'admin' ? 'Make agent' : 'Make admin'
        roleButton.onclick = () => void patchAgent(agent.id, { role: agent.role === 'admin' ? 'agent' : 'admin' })
        const enableButton = document.createElement('button')
        enableButton.type = 'button'
        enableButton.className = 'btn-ghost'
        enableButton.textContent = agent.enabled ? 'Disable' : 'Enable'
        enableButton.onclick = () => {
          if (agent.enabled && !confirm(`Disable ${agent.name}? They will be signed out on their next page load.`)) return
          void patchAgent(agent.id, { enabled: !agent.enabled })
        }
        actions.append(roleButton, enableButton)
        if (boot.authMode !== 'access') {
          const resetButton = document.createElement('button')
          resetButton.type = 'button'
          resetButton.className = 'btn-ghost'
          resetButton.textContent = 'Reset password'
          resetButton.onclick = () => {
            const password = prompt(`New temporary password for ${agent.name} (12+ characters):`)
            if (password) void patchAgent(agent.id, { password })
          }
          actions.append(resetButton)
        }
        row.append(actions)
      }
      return row
    })
  )
}

async function patchAgent(id: string, patch: { role?: 'admin' | 'agent'; enabled?: boolean; password?: string; name?: string }): Promise<void> {
  try {
    const { agent } = await api<{ agent: AgentSummary }>(`/api/host/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    upsertAgent(agent)
    toast(patch.password ? 'Password reset.' : 'Saved.')
  } catch (error) {
    toast(describe(error), true)
  }
}

/** The "Add an agent" form (admins) and the "Change your password" form (password mode). */
export function wireTeamForms(): void {
  if (els.agentForm) {
    els.agentForm.onsubmit = async (event) => {
      event.preventDefault()
      const button = els.agentForm.querySelector('button[type="submit"]') as HTMLButtonElement | null
      if (button) button.disabled = true
      try {
        const { agent } = await api<{ agent: AgentSummary }>('/api/host/agents', {
          method: 'POST',
          body: JSON.stringify({
            name: $<HTMLInputElement>('agent-name').value,
            email: $<HTMLInputElement>('agent-email').value,
            password: (document.getElementById('agent-password') as HTMLInputElement | null)?.value ?? '',
            role: $<HTMLInputElement>('agent-admin').checked ? 'admin' : 'agent'
          })
        })
        upsertAgent(agent)
        els.agentForm.reset()
        toast(`${agent.name} added. They sign in at ${boot.baseUrl}/host with the password you gave them.`)
      } catch (error) {
        toast(describe(error), true)
      } finally {
        if (button) button.disabled = false
      }
    }
  }

  if (els.passwordForm) {
    els.passwordForm.onsubmit = async (event) => {
      event.preventDefault()
      const status = $<HTMLElement>('pw-status')
      try {
        await api<{ ok: true }>('/api/host/me/password', {
          method: 'POST',
          body: JSON.stringify({ current: $<HTMLInputElement>('pw-current').value, next: $<HTMLInputElement>('pw-next').value })
        })
        els.passwordForm.reset()
        status.textContent = 'Password updated.'
      } catch (error) {
        status.textContent = describe(error)
      }
    }
  }
}
