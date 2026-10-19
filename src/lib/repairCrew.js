// Crew clean-up for repair tickets (ruling R30): when a ticket is declined, or moved back to รับเรื่อง,
// its booked crew from today on is released -- except rows a worker already checked in on (confirmed_at).
import { supabase } from './supabase.js'
import { bangkokTodayIso } from './photoUpload.js'

// Does a move from -> to release the crew? ไม่รับ always; back to รับเรื่อง from a booked status.
export function releasesCrew(from, to) {
  return to === 'declined' || (to === 'received' && from !== 'pending_review')
}

// Deletes the ticket's unconfirmed worker_assignments dated today (Bangkok) or later. Returns { error }.
export async function removeFutureUnconfirmedCrew(ticketId) {
  const { error } = await supabase.from('worker_assignments').delete()
    .eq('repair_ticket_id', ticketId).gte('date', bangkokTodayIso()).is('confirmed_at', null)
  return { error }
}
