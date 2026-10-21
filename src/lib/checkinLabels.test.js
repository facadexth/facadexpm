import { describe, it, expect } from 'vitest'
import { checkinPageLabels } from './checkinLabels.js'

describe('checkinPageLabels', () => {
  it('site check-in keeps the existing title and subtitle', () => {
    expect(checkinPageLabels({ actionType: 'check_in', workerName: 'ชัย', siteName: 'บ้านคุณบิ๊ก' })).toEqual({
      title: '📍 เช็คอิน',
      subtitle: 'สวัสดีครับคุณชัย — บ้านคุณบิ๊ก',
      farFrom: 'ห่างจากไซท์งาน',
    })
    expect(checkinPageLabels({ actionType: 'check_out', workerName: 'ชัย', siteName: 'บ้านคุณบิ๊ก' }).title).toBe('📍 เช็คเอาท์')
  })

  it('location check-in says "เช็คอินที่ <location>"', () => {
    expect(checkinPageLabels({ actionType: 'check_in', workerName: 'โปรย', siteName: 'สำนักงาน', placeKind: 'location' })).toEqual({
      title: '📍 เช็คอินที่ สำนักงาน',
      subtitle: 'สวัสดีครับคุณโปรย',
      farFrom: 'ห่างจากตำแหน่งที่กำหนด',
    })
    expect(checkinPageLabels({ actionType: 'check_out', workerName: 'โปรย', siteName: 'สำนักงาน', placeKind: 'location' }).title).toBe('📍 เช็คเอาท์ที่ สำนักงาน')
  })
})
