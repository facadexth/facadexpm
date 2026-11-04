// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'

const replace = vi.fn(async () => 'new.png')
const remove = vi.fn(async () => {})
vi.mock('../../lib/profileImages.js', () => ({
  replaceProfileImage: (...a) => replace(...a),
  removeProfileImage: (...a) => remove(...a),
  thicknessLabel: t => (t ? `t = ${t} mm` : 't = ?'),
}))

const { default: ProfileImageCard } = await import('./ProfileImageCard.jsx')
afterEach(() => { cleanup(); replace.mockClear(); remove.mockReset(); remove.mockImplementation(async () => {}) })

const profile = { id: 'P', name: 'ธรณีสวิง', drawing_no: '3067', thickness_mm: 1.2, image_path: 'T/profiles/P.png' }

describe('ProfileImageCard', () => {
  it('shows the picture and the thickness note', () => {
    const { container, getByAltText } = render(<ProfileImageCard profile={profile} label="ธรณีสวิง 1.2 มม." url="https://s/x" tenantId="T" canEdit />)
    expect(getByAltText('3067').getAttribute('src')).toBe('https://s/x')
    expect(container.textContent).toContain('t = 1.2 mm')
  })

  it('uploads a chosen file for this profile and reloads', async () => {
    const onChanged = vi.fn()
    const { container } = render(<ProfileImageCard profile={profile} label="x" url="u" tenantId="T" canEdit onChanged={onChanged} />)
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    fireEvent.change(container.querySelector('input[type=file]'), { target: { files: [file] } })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(replace).toHaveBeenCalledWith({ tenantId: 'T', profile, file })
  })

  it('asks before removing, and shows a failure in the card', async () => {
    remove.mockImplementation(async () => { throw new Error('ไม่มีสิทธิ์') })
    const { getByText, container } = render(<ProfileImageCard profile={profile} label="x" url="u" tenantId="T" canEdit />)
    fireEvent.click(getByText('ลบรูป'))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(getByText('ยืนยันลบ'))
    await waitFor(() => expect(container.textContent).toContain('ไม่มีสิทธิ์'))
    expect(remove).toHaveBeenCalledWith({ profile })
  })

  it('has no buttons for someone who cannot edit', () => {
    const { queryByText } = render(<ProfileImageCard profile={{ ...profile, image_path: null }} label="x" tenantId="T" canEdit={false} />)
    expect(queryByText('อัปโหลดรูป')).toBeNull()
    expect(queryByText('ยังไม่มีรูป')).not.toBeNull()
  })
})
