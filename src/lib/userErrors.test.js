import { describe, it, expect } from 'vitest'
import { friendlyUserError } from './userErrors.js'

const rls = { message: 'new row violates row-level security policy for table "user_roles"' }

describe('friendlyUserError', () => {
  it('blames the package only when the admin seats really are full', () => {
    expect(friendlyUserError(rls, { adminsFull: true })).toContain('เกินจำนวน Admin')
  })
  it('does not claim a quota problem when seats are free', () => {
    const m = friendlyUserError(rls, { adminsFull: false })
    expect(m).not.toContain('เกินจำนวน')
    expect(m).toContain('support@changpm.app')
  })
  it('defaults to not blaming the package', () => {
    expect(friendlyUserError(rls)).not.toContain('เกินจำนวน')
  })
  it('passes other errors through', () => {
    expect(friendlyUserError({ message: 'boom' })).toBe('Error: boom')
    expect(friendlyUserError(null)).toBe('Error: ')
  })
})
