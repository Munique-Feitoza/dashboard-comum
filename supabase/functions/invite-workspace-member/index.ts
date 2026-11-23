import { createClient } from 'npm:@supabase/supabase-js@2.119.2';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function json(body: Record<string, unknown>, status = 200, origin?: string) {
  const headers = new Headers(jsonHeaders);
  if (origin) headers.set('access-control-allow-origin', origin);
  headers.set('vary', 'Origin');
  return new Response(JSON.stringify(body), { status, headers });
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get('origin') ?? '';
  const allowedOrigins = (Deno.env.get('APP_ALLOWED_ORIGINS') ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const localDevelopment = origin === 'http://localhost:3000';
  if (request.method === 'OPTIONS') {
    if (localDevelopment || allowedOrigins.includes(origin)) return new Response('ok', { headers: { ...jsonHeaders, 'access-control-allow-origin': origin, vary: 'Origin' } });
    return json({ error: 'Origin not allowed' }, 403);
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
  if (!localDevelopment && !allowedOrigins.includes(origin)) return json({ error: 'Origin not allowed' }, 403);

  const authorization = request.headers.get('authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return json({ error: 'Authentication required' }, 401, origin);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const publishableKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    return json({ error: 'Server configuration is incomplete' }, 500, origin);
  }

  const callerClient = createClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authData, error: authError } = await callerClient.auth.getUser(bearer);
  if (authError || !authData.user) return json({ error: 'Invalid session' }, 401, origin);

  let input: { workspaceId?: string; email?: string; role?: string };
  try {
    input = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, origin);
  }
  const workspaceId = input.workspaceId?.trim();
  const email = input.email?.trim().toLowerCase();
  const role = input.role?.toLowerCase();
  if (!workspaceId || !/^[0-9a-f-]{36}$/i.test(workspaceId)) return json({ error: 'Invalid workspaceId' }, 400, origin);
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Invalid email' }, 400, origin);
  if (role !== 'admin' && role !== 'manager') return json({ error: 'Role must be admin or manager' }, 400, origin);
  if (email === authData.user.email?.toLowerCase()) return json({ error: 'You cannot invite your own account' }, 400, origin);
  const appBaseUrl = Deno.env.get('APP_BASE_URL');
  if (!appBaseUrl) return json({ error: 'APP_BASE_URL is not configured' }, 500, origin);

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: membership, error: membershipError } = await adminClient
    .from('workspace_memberships')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', authData.user.id)
    .eq('status', 'active')
    .maybeSingle();
  if (membershipError) return json({ error: 'Could not verify workspace permission' }, 500, origin);
  if (membership?.role !== 'admin') return json({ error: 'Workspace admin permission required' }, 403, origin);

  const { data: invite, error: inviteError } = await adminClient
    .from('workspace_invites')
    .upsert({ workspace_id: workspaceId, email, role, invited_by: authData.user.id, status: 'pending', expires_at: new Date(Date.now() + 7 * 86400000).toISOString() }, { onConflict: 'workspace_id,email' })
    .select('id')
    .single();
  if (inviteError) return json({ error: 'Could not create invitation' }, 409, origin);

  const { data: invited, error: authInviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${appBaseUrl.replace(/\/$/, '')}/auth/callback`,
    data: { invited_workspace_id: workspaceId },
  });
  if (authInviteError || !invited.user) {
    await adminClient.from('workspace_invites').delete().eq('id', invite.id);
    return json({ error: authInviteError?.message ?? 'Could not send invitation' }, 409, origin);
  }

  const { error: membershipInsertError } = await adminClient
    .from('workspace_memberships')
    .upsert({ workspace_id: workspaceId, user_id: invited.user.id, role, status: 'invited' }, { onConflict: 'workspace_id,user_id' });
  if (membershipInsertError) {
    return json({ error: 'Invitation was sent, but workspace membership could not be recorded' }, 500, origin);
  }

  return json({ invitationId: invite.id, email, role, status: 'pending' }, 201, origin);
});
