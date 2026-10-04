import { describe, it, expect } from 'vitest'
import { formatWeekMessage } from '../../supabase/functions/_shared/week-message.ts'

const day = (dateLabel, sites) => ({ dateLabel, sites })
const site = (siteName, morning = [], evening = [], siteNumber) => ({ siteName, siteNumber, morning, evening })

describe('formatWeekMessage', () => {
  it('shows date header, site pin and workers per shift', () => {
    const t = formatWeekMessage('งานอาทิตย์หน้า', [day('จ 05/10', [site('SOAP OPERA', ['นก', 'ต้อม'], ['เอ'], 'S-01')])])
    expect(t).toContain('📆 จ 05/10')
    expect(t).toContain('📍 S-01 SOAP OPERA')
    expect(t).toContain('🌅 เช้า: นก, ต้อม')
    expect(t).toContain('🌆 บ่าย: เอ')
  })
  it('marks an empty day on one line', () => {
    expect(formatWeekMessage('x', [day('อา 11/10', [])])).toContain('💤 ว่าง')
  })
  it('omits workers when asked (personal view)', () => {
    const t = formatWeekMessage('x', [day('จ 05/10', [site('A', ['นก'])])], false)
    expect(t).toContain('📍 A')
    expect(t).not.toContain('นก')
  })
  it('lists a repeated name once', () => {
    expect(formatWeekMessage('x', [day('จ', [site('A', ['นก', 'นก'])])])).toContain('เช้า: นก\n'.trim())
  })
  it('stays under the LINE limit and says what was cut', () => {
    const big = Array.from({ length: 7 }, (_, i) => day(`d${i}`, Array.from({ length: 12 }, (_, k) => site('โครงการ'.repeat(8) + k, ['ช่างหนึ่ง', 'ช่างสอง', 'ช่างสาม'].concat(Array(10).fill('ชื่อยาวมาก'))))))
    const t = formatWeekMessage('x', big)
    expect(t.length).toBeLessThanOrEqual(5000)
    expect(t).toContain('ยังมีอีก')
  })
})

import { siteMapLink } from '../../supabase/functions/_shared/site-map-link.ts'

describe('map link in schedule messages', () => {
  it('shows the link under the site pin', () => {
    const t = formatWeekMessage('x', [{ dateLabel: 'จ', sites: [{ siteName: 'A', mapUrl: 'https://maps.app.goo.gl/abc', morning: ['นก'], evening: [] }] }])
    expect(t).toContain('📍 A\n   🗺️ https://maps.app.goo.gl/abc')
  })
  it('uses the saved link, else the coordinates, else nothing', () => {
    expect(siteMapLink({ map_url: ' https://maps.app.goo.gl/x ', lat: 1, lng: 2 })).toBe('https://maps.app.goo.gl/x')
    expect(siteMapLink({ map_url: '', lat: 13.7, lng: 100.5 })).toBe('https://www.google.com/maps?q=13.7,100.5')
    expect(siteMapLink({ map_url: 'ไม่มีลิงก์', lat: null, lng: null })).toBeNull()
    expect(siteMapLink({ map_url: 'javascript:alert(1)' })).toBeNull()
  })
})
