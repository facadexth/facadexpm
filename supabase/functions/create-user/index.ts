import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const adminClient = createClient(supabaseUrl, supabaseServiceKey)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// Creates a login for a teammate of the caller's own company, already
// email-confirmed, so crew who never use email can sign in right away.
// Only the auth user is created here. The role row is written by the
// handle_new_user trigger (WORKER) and then set by the OWNER's own session
// from the client: the seat-limit trigger reads current_tenant_id() from the
// caller's JWT, so a service-role write here would silently skip the quota.
Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: userError } = await adminClient.auth.getUser(token)
    if (userError || !user) return json({ error: 'Unauthorized' }, 401)

    const { data: callerRole } = await adminClient
      .from('user_roles')
      .select('role, tenant_id')
      .eq('user_email', user.email)
      .maybeSingle()

    if (callerRole?.role !== 'OWNER' || !callerRole.tenant_id) {
      return json({ error: 'Only OWNER can create users' }, 403)
    }

    const { email, password } = await req.json()
    if (!email || !password) return json({ error: 'Missing required fields' }, 400)
    if (String(password).length < 6) return json({ error: 'Password must be at least 6 characters' }, 400)

    // The tenant comes from the caller's own row, never from the request body.
    const { data, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { invited_tenant_id: callerRole.tenant_id },
    })

    if (createError) return json({ error: createError.message }, 400)

    return json({ success: true, user: { id: data.user?.id, email: data.user?.email } })
  } catch (error) {
    return json({ error: (error as Error).message }, 500)
  }
})
