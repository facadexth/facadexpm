import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const adminClient = createClient(supabaseUrl, supabaseServiceKey)

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    // Verify OWNER
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return new Response('Unauthorized', { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: userError } = await adminClient.auth.getUser(token)
    if (userError || !user) return new Response('Unauthorized', { status: 401 })

    // Check if OWNER
    const { data: roleData } = await adminClient
      .from('user_roles')
      .select('role')
      .eq('user_email', user.email)
      .single()

    if (roleData?.role !== 'OWNER') {
      return new Response(JSON.stringify({ error: 'Only OWNER can create users' }), { 
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const { email, password, role } = await req.json()

    if (!email || !password || !role) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Create auth user
    const { data: { user: newUser }, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    })

    if (createError) {
      return new Response(JSON.stringify({ error: createError.message }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Create role record
    const { error: roleError } = await adminClient
      .from('user_roles')
      .insert({ user_email: email, role })

    if (roleError) {
      return new Response(JSON.stringify({ error: roleError.message }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ success: true, user: newUser }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})
