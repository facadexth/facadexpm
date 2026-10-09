// supabase.js stand-in for the Login / ResetPassword harness: records auth calls, answers from window.__auth.
const W = typeof window !== 'undefined' ? window : {}
const rec = (name, args) => { (W.__calls = W.__calls || []).push([name, ...args]) }
export const supabase = {
  auth: {
    resetPasswordForEmail: async (...a) => { rec('resetPasswordForEmail', a); return { data: {}, error: (W.__auth && W.__auth.reset) || null } },
    updateUser: async (...a) => { rec('updateUser', a); return { data: {}, error: (W.__auth && W.__auth.update) || null } },
    signOut: async (...a) => { rec('signOut', a); return { error: null } },
    signInWithPassword: async (...a) => { rec('signInWithPassword', a); return { error: null } },
    signUp: async (...a) => { rec('signUp', a); return { data: {}, error: null } },
  },
}
export const fmt = n => String(n)
export const fmtDate = d => String(d)
