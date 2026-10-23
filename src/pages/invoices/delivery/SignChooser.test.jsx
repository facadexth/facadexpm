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
vi.mock('../../../lib/supabase.js', () => ({ supabase: {} }))
vi.mock('../../../components/DocumentReceiptModal.jsx', () => ({
  default: ({ documentType, onSaved }) => <button onClick={() => onSaved({ id: 'rcpt1' })}>save-{documentType}</button>,
}))
vi.mock('../../../components/SignLinkModal.jsx', () => ({
  default: ({ documentType, documentId }) => <div>link-{documentType}-{documentId}</div>,
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
})
