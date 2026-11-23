import { createClient } from 'npm:@supabase/supabase-js@2.119.2';

type OAuthState = { state_hash: string; workspace_id: string; platform: 'google_ad_manager' | 'google_adsense'; requested_by: string; expires_at: string };
const appUrl = () => (Deno.env.get('APP_BASE_URL') ?? '').replace(/\/$/, '');
const redirect = (result: string) => Response.redirect(`${appUrl()}/?integration=${encodeURIComponent(result)}`, 303);

Deno.serve(async (request: Request) => {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  if (!appUrl()) return new Response('APP_BASE_URL is not configured', { status: 500 });
  const params = new URL(request.url).searchParams;
  const state = params.get('state');
  const code = params.get('code');
  const googleError = params.get('error');
  if (!state) return redirect('invalid_state');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  const encryptionKey = Deno.env.get('GOOGLE_TOKEN_ENCRYPTION_KEY');
  if (!supabaseUrl || !serviceKey || !clientId || !clientSecret || !encryptionKey) return redirect('server_configuration_error');

  const stateDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state)));
  const stateHash = Array.from(stateDigest, byte => byte.toString(16).padStart(2, '0')).join('');
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data } = await admin.from('google_oauth_states').select('*').eq('state_hash', stateHash).maybeSingle();
  if (!data) return redirect('invalid_state');
  const oauthState = data as OAuthState;
  await admin.from('google_oauth_states').delete().eq('state_hash', stateHash);
  if (Date.parse(oauthState.expires_at) < Date.now()) return redirect('state_expired');
  const { data: membership } = await admin.from('workspace_memberships').select('role')
    .eq('workspace_id', oauthState.workspace_id).eq('user_id', oauthState.requested_by).eq('status', 'active').maybeSingle();
  if (membership?.role !== 'admin') return redirect('permission_revoked');
  if (googleError || !code) return redirect(googleError === 'access_denied' ? 'cancelled' : 'authorization_error');

  const redirectUri = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/google-oauth-callback`;
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  if (!tokenResponse.ok) return redirect('token_exchange_error');
  const tokens = await tokenResponse.json() as { refresh_token?: string; scope?: string };
  if (!tokens.refresh_token) return redirect('refresh_token_missing');
  const requiredScope = oauthState.platform === 'google_ad_manager'
    ? 'https://www.googleapis.com/auth/admanager.readonly'
    : 'https://www.googleapis.com/auth/adsense.readonly';
  if (!tokens.scope?.split(' ').includes(requiredScope)) return redirect('required_scope_missing');

  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(encryptionKey), character => character.charCodeAt(0));
    if (keyBytes.byteLength !== 32) return redirect('invalid_encryption_key');
  } catch { return redirect('invalid_encryption_key'); }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherText = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(tokens.refresh_token)));
  const combined = new Uint8Array(iv.length + cipherText.length);
  combined.set(iv); combined.set(cipherText, iv.length);
  const encryptedToken = `\\x${Array.from(combined, byte => byte.toString(16).padStart(2, '0')).join('')}`;

  const { data: connection, error: connectionError } = await admin.from('ad_platform_connections')
    .upsert({ workspace_id: oauthState.workspace_id, platform: oauthState.platform, status: 'connected', last_error_code: null }, { onConflict: 'workspace_id,platform' })
    .select('id').single();
  if (connectionError || !connection) return redirect('connection_save_error');
  const { error: credentialError } = await admin.from('google_oauth_credentials').upsert({
    connection_id: connection.id,
    encrypted_refresh_token: encryptedToken,
    encryption_key_version: 1,
    scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'connection_id' });
  if (credentialError) {
    await admin.from('ad_platform_connections').update({ status: 'error', last_error_code: 'credential_save_failed' }).eq('id', connection.id);
    return redirect('credential_save_error');
  }
  return redirect('connected');
});
