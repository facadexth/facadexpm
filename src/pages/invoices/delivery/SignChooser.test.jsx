// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const issued = vi.fn(async () => ({}))
const signed = vi.fn(async () => ({}))
vi.mock('../../../hooks/useDeliveryReport.js', () => ({
  markDeliveryReportIssued: (...a) => issued(...a),
  markDeliveryReportSigned: (...a) => signed(...a),
  useDeliveryReport: () => ({ data: null, loading: false, error: null }),
}))
vi.mock('../../../hooks/useBackToClose.js', () => ({ useBackToClose: () => {} }))
const sb = { inserts: 0, uploads: 0 }
vi.mock('../../../lib/supabase.js', () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: { user: { email: 'a@b' } } } }) },
  storage: { from: () => ({ upload: async () => { sb.uploads++; return { error: null } }, remove: async () => ({}) }) },
  from: () => ({ insert: async () => { sb.inserts++; return { error: null } } }),
} }))
vi.mock('../../../components/DocumentReceiptModal.jsx', () => ({
  default: ({ documentType, onSaved }) => <button onClick={() => onSaved({ id: 'rcpt1' })}>save-{documentType}</button>,
}))
vi.mock('../../../components/SignLinkModal.jsx', () => ({
  default: ({ documentType, documentId, onClose }) => <div>link-{documentType}-{documentId}<button onClick={onClose}>close-link</button></div>,
}))

import SignChooser from './SignChooser.jsx'

afterEach(() => { cleanup(); issued.mockClear(); signed.mockClear() })

describe('SignChooser', () => {
  it('renders the 3 signing options', () => {
    render(<SignChooser report={{ id: 'r1', status: 'issued' }} tenantId="t1" onClose={() => {}} />)
    expect(screen.getByText(/พิมพ์แล้วเซ็นบนกระดาษ/)).toBeTruthy()
    expect(screen.getByText(/เซ็นบนเครื่องนี้/)).toBeTruthy()
    expect(screen.getByText(/ส่งลิงก์ให้ลูกค้า/)).toBeTruthy()
  })

  it('this-device path: draft becomes issued, onSaved marks the report signed with the receipt id', async () => {
    const onSigned = vi.fn(); const onClose = vi.fn()
    render(<SignChooser report={{ id: 'r1', status: 'draft' }} tenantId="t1" onClose={onClose} onSigned={onSigned} />)
    fireEvent.click(screen.getByText(/เซ็นบนเครื่องนี้/))
    await waitFor(() => screen.getByText('save-delivery_report'))
    expect(issued).toHaveBeenCalledWith('r1')
    fireEvent.click(screen.getByText('save-delivery_report'))
    await waitFor(() => expect(signed).toHaveBeenCalledWith('r1', 'rcpt1'))
    expect(onSigned).toHaveBeenCalled(); expect(onClose).toHaveBeenCalled()
  })

  it('remote path opens the sign link for this report, issued report not re-issued', async () => {
    render(<SignChooser report={{ id: 'r9', status: 'issued' }} tenantId="t1" onClose={() => {}} />)
    fireEvent.click(screen.getByText(/ส่งลิงก์ให้ลูกค้า/))
    await waitFor(() => screen.getByText('link-delivery_report-r9'))
    expect(issued).not.toHaveBeenCalled()
  })

  it('device path: status update fails -> retry re-runs only the status update', async () => {
    let saves = 0
    signed.mockRejectedValueOnce(new Error('boom'))
    render(<SignChooser report={{ id: 'r1', status: 'issued' }} tenantId="t1" onClose={() => {}} />)
    fireEvent.click(screen.getByText(/เซ็นบนเครื่องนี้/))
    const save = await screen.findByText('save-delivery_report')
    save.addEventListener('click', () => { saves++ })
    fireEvent.click(save)
    const retry = await screen.findByText('ลองบันทึกสถานะอีกครั้ง')
    expect(screen.getByText('boom')).toBeTruthy()
    fireEvent.click(retry)
    await waitFor(() => expect(signed).toHaveBeenCalledTimes(2))
    expect(signed.mock.calls[1]).toEqual(['r1', 'rcpt1'])
    expect(saves).toBe(1)
  })

  it('closing the remote link modal does not call onSigned', async () => {
    const onSigned = vi.fn(); const onClose = vi.fn()
    render(<SignChooser report={{ id: 'r9', status: 'issued' }} tenantId="t1" onClose={onClose} onSigned={onSigned} />)
    fireEvent.click(screen.getByText(/ส่งลิงก์ให้ลูกค้า/))
    fireEvent.click(await screen.findByText('close-link'))
    expect(onClose).toHaveBeenCalled(); expect(onSigned).not.toHaveBeenCalled()
  })

  it('paper path: status update fails -> retry does not re-upload or re-insert', async () => {
    signed.mockRejectedValueOnce(new Error('boom'))
    render(<SignChooser report={{ id: 'r1', status: 'issued' }} tenantId="t1" onClose={() => {}} />)
    fireEvent.click(screen.getByText(/พิมพ์แล้วเซ็นบนกระดาษ/))
    fireEvent.change(await screen.findByPlaceholderText('ชื่อผู้เซ็นรับ'), { target: { value: 'สมชาย' } })
    const f = new File(['x'], 'a.jpg', { type: 'image/jpeg' })
    fireEvent.change(screen.getByLabelText('แนบรูปใบที่เซ็นแล้ว'), { target: { files: [f] } })
    fireEvent.click(screen.getByText('บันทึกว่าเซ็นแล้ว'))
    fireEvent.click(await screen.findByText('ลองบันทึกสถานะอีกครั้ง'))
    await waitFor(() => expect(signed).toHaveBeenCalledTimes(2))
    expect(sb.uploads).toBe(1); expect(sb.inserts).toBe(1)
    expect(signed.mock.calls[0][1]).toBe(signed.mock.calls[1][1])
  })
})
