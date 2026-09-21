import { describe, expect, it } from 'vitest'
import { publicBaseUrl } from '../src/lib/base-url'
import type { Env } from '../src/types'

const env = (PUBLIC_BASE_URL?: string) => ({ PUBLIC_BASE_URL }) as unknown as Env

describe('public base URL', () => {
  it('is the origin the request arrived on when nothing is configured', () => {
    expect(publicBaseUrl(env(), new Request('https://founderlive.acme.workers.dev/host?tab=live'))).toBe(
      'https://founderlive.acme.workers.dev'
    )
  })

  it('prefers a configured value, without a trailing slash', () => {
    expect(publicBaseUrl(env('https://live.example.com/'), new Request('https://founderlive.acme.workers.dev/'))).toBe(
      'https://live.example.com'
    )
  })

  it('treats a blank value as unset', () => {
    expect(publicBaseUrl(env('   '), new Request('http://localhost:8787/embed/config'))).toBe('http://localhost:8787')
  })
})
