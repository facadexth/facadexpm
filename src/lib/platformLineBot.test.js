import { describe, it, expect } from 'vitest'
import { platformBotLabel, PLATFORM_BOT_NAME, PLATFORM_BOT_BASIC_ID } from './platformLineBot.js'

describe('platformBotLabel', () => {
  it('shows just the @ID while the bot has no confirmed name', () => {
    expect(platformBotLabel(null, '302yljzw')).toBe('@302yljzw')
  })
  it('shows the name and the @ID once a name is set', () => {
    expect(platformBotLabel('ADMIN CHANG', '302yljzw')).toBe('ADMIN CHANG (@302yljzw)')
  })
  it('uses the configured name and ID by default', () => {
    expect(platformBotLabel()).toBe(platformBotLabel(PLATFORM_BOT_NAME, PLATFORM_BOT_BASIC_ID))
    expect(platformBotLabel()).toContain(`@${PLATFORM_BOT_BASIC_ID}`)
  })
})
