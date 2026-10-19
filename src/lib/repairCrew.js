// Crew clean-up for repair tickets (ruling R30): when a ticket is declined, or moved back to รับเรื่อง,
// its booked crew from today on is released -- except rows a worker already checked in on (confirmed_at).
import { supabase } from './supabase.js'
import { bangkokTodayIso } from './photoUpload.js'

// Does a move from -> to release the crew? ไม่รับ always; back to รับเรื่อง from a booked status.
export function releasesCrew(from, to) {
  return to === 'declined' || (to === 'received' && from !== 'pending_review')
}

// Deletes the ticket's unconfirmed worker_assignments dated today (Bangkok) or later. Returns { error }.
// Only the ticket's own crew rows: type 'site' at the ticket's site. A row Assign/HR turned into leave or
// another site is never touched, even if a stale repair link survived (the -11 trigger also clears those).
export async function removeFutureUnconfirmedCrew(ticketId, siteId) {
  if (!ticketId || !siteId) return { error: new Error('ไม่พบงานซ่อมหรือไซต์ของงานซ่อม') }
  const { error } = await supabase.from('worker_assignments').delete()
    .eq('repair_ticket_id', ticketId).eq('type', 'site').eq('site_id', siteId)
    .gte('date', bangkokTodayIso()).is('confirmed_at', null)
  return { error }
}
