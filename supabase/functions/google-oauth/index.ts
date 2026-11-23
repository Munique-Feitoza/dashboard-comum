import { createClient } from 'npm:@supabase/supabase-js@2.119.2';

const scopes = {
  google_ad_manager: 'https://www.googleapis.com/auth/admanager.readonly',
  google_adsense: 'https://www.googleapis.com/auth/adsense.readonly',
} as const;
type Platform = keyof typeof scopes;
const commonHeaders = {
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
function json(body: Record<string, unknown>, status: number, origin: string) {
  const headers = new Headers(commonHeaders);
  headers.set('access-control-allow-origin', origin);
  headers.set('vary', 'Origin');
  return new Response(JSON.stringify(body), { status, headers });
}
Deno.serve(async (request: Request) => {
  const origin = request.headers.get('origin') ?? '';
  const allowed = (Deno.env.get('APP_ALLOWED_ORIGINS') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (request.method === 'OPTIONS') {
    if (origin === 'http://localhost:3000' || allowed.includes(origin)) return new Response('ok', { headers: { ...commonHeaders, 'access-control-allow-origin': origin, vary: 'Origin' } });
    return json({ error: 'Origin not allowed' }, 403, 'null');
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin || 'null');
  if (origin !== 'http://localhost:3000' && !allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403, 'null');
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return json({ error: 'Authentication required' }, 401, origin);
  const url = Deno.env.get('SUPABASE_URL');
  const publishableKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const googleClientId = Deno.env.get('GOOGLE_CLIENT_ID');
  if (!url || !publishableKey || !serviceKey || !googleClientId) return json({ error: 'Server integration settings are incomplete' }, 500, origin);
  const userClient = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: authData, error: authError } = await userClient.auth.getUser(bearer);
  if (authError || !authData.user) return json({ error: 'Invalid session' }, 401, origin);
  let input: { workspaceId?: string; platform?: Platform };
  try { input = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400, origin); }
  const workspaceId = input.workspaceId?.trim();
  const platform = input.platform;
  if (!workspaceId || !/^[0-9a-f-]{36}$/i.test(workspaceId)) return json({ error: 'Invalid workspaceId' }, 400, origin);
  if (!platform || !(platform in scopes)) return json({ error: 'Unsupported Google platform' }, 400, origin);
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: member } = await admin.from('workspace_memberships').select('role').eq('workspace_id', workspaceId).eq('user_id', authData.user.id).eq('status', 'active').maybeSingle();
  if (member?.role !== 'admin') return json({ error: 'Workspace admin permission required' }, 403, origin);

  const redirectUri = `${url.replace(/\/$/, '')}/functions/v1/google-oauth-callback`;
  const random = crypto.getRandomValues(new Uint8Array(32));
  const state = btoa(String.fromCharCode(...random)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state)));
  const stateHash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  const { error: stateError } = await admin.from('google_oauth_states').insert({ state_hash: stateHash, workspace_id: workspaceId, platform, requested_by: authData.user.id });
  if (stateError) return json({ error: 'Could not start Google authorization' }, 500, origin);
  const { error: connectionError } = await admin.from('ad_platform_connections').upsert({ workspace_id: workspaceId, platform, status: 'pending' }, { onConflict: 'workspace_id,platform' });
  if (connectionError) {
    await admin.from('google_oauth_states').delete().eq('state_hash', stateHash);
    return json({ error: 'Could not prepare platform connection' }, 500, origin);
  }
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizationUrl.search = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `openid email ${scopes[platform]}`,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  }).toString();
  return json({ authorizationUrl: authorizationUrl.toString() }, 200, origin);
});
