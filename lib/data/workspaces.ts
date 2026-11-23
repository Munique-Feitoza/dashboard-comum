import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export type WorkspaceRole = 'admin' | 'manager';
export type AdPlatform = 'google_ad_manager' | 'google_adsense';

export type WorkspaceMembership = {
  workspace_id: string;
  role: WorkspaceRole;
  status: 'active' | 'invited' | 'suspended';
  workspace: { id: string; name: string; created_at: string };
};

function requireClient() {
  const client = getSupabaseBrowserClient();
  if (!client) throw new Error('Supabase não está configurado neste ambiente.');
  return client;
}

export async function createWorkspace(name: string) {
  const client = requireClient();
  const { data, error } = await client.rpc('create_workspace', { workspace_name: name.trim() });
  if (error) throw error;
  return data as string;
}

export async function getMyWorkspaces() {
  const client = requireClient();
  const { data, error } = await client.from('workspace_memberships')
    .select('workspace_id, role, status, workspaces!inner(id, name, created_at)')
    .eq('status', 'active')
    .order('created_at', { referencedTable: 'workspaces', ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as WorkspaceMembership[];
}

export async function getProperties(workspaceId: string) {
  const client = requireClient();
  const { data, error } = await client.from('properties')
    .select('id, workspace_id, domain, display_name, category, status, created_at, updated_at')
    .eq('workspace_id', workspaceId).order('domain');
  if (error) throw error;
  return data ?? [];
}

export async function addProperty(input: {
  workspaceId: string;
  domain: string;
  displayName?: string;
  category?: string;
}) {
  const client = requireClient();
  const domain = input.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const { data, error } = await client.from('properties').insert({
    workspace_id: input.workspaceId,
    domain,
    display_name: input.displayName?.trim() || null,
    category: input.category ?? 'other',
  }).select().single();
  if (error) throw error;
  return data;
}

export async function getDailyProfit(workspaceId: string, from: string, to: string) {
  const client = requireClient();
  const { data, error } = await client.from('workspace_profit_daily')
    .select('report_date, gross_revenue, operating_costs, estimated_profit, pageviews, impressions')
    .eq('workspace_id', workspaceId)
    .gte('report_date', from).lte('report_date', to).order('report_date');
  if (error) throw error;
  return data ?? [];
}

export async function addOperatingExpense(input: {
  workspaceId: string;
  propertyId?: string;
  expenseDate: string;
  category: 'content' | 'team' | 'technology' | 'operations' | 'taxes' | 'other';
  description: string;
  amount: number;
  recurring?: boolean;
}) {
  const client = requireClient();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) throw userError ?? new Error('Sessão expirada. Entre novamente.');
  const { data, error } = await client.from('operating_expenses').insert({
    workspace_id: input.workspaceId,
    property_id: input.propertyId || null,
    expense_date: input.expenseDate,
    category: input.category,
    description: input.description.trim(),
    amount: input.amount,
    recurring: input.recurring ?? false,
    created_by: userData.user.id,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function inviteWorkspaceMember(input: { workspaceId: string; email: string; role: WorkspaceRole }) {
  const client = requireClient();
  const { data, error } = await client.functions.invoke('invite-workspace-member', {
    body: { workspaceId: input.workspaceId, email: input.email.trim().toLowerCase(), role: input.role },
  });
  if (error) throw error;
  return data as { invitationId: string; email: string; role: WorkspaceRole; status: 'pending' };
}

export async function startGoogleConnection(workspaceId: string, platform: AdPlatform) {
  const client = requireClient();
  const { data, error } = await client.functions.invoke('google-oauth', { body: { workspaceId, platform } });
  if (error) throw error;
  const authorizationUrl = (data as { authorizationUrl?: string } | null)?.authorizationUrl;
  if (!authorizationUrl || !authorizationUrl.startsWith('https://accounts.google.com/')) {
    throw new Error('O servidor retornou um endereço de autorização inválido.');
  }
  window.location.assign(authorizationUrl);
}
