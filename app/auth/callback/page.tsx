'use client';

import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export default function AuthCallbackPage() {
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    async function finishAuth() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) { setError('Autenticação ainda não configurada.'); return; }
      const { error: sessionError } = await supabase.auth.exchangeCodeForSession(window.location.href);
      if (sessionError) { setError(sessionError.message); return; }
      const workspaceName = localStorage.getItem('monetize-new-workspace');
      if (workspaceName) {
        const { error: workspaceError } = await supabase.rpc('create_workspace', { workspace_name: workspaceName });
        if (workspaceError) { setError(workspaceError.message); return; }
        localStorage.removeItem('monetize-new-workspace');
      }
      if (!cancelled) window.location.assign('/');
    }
    void finishAuth();
    return () => { cancelled = true; };
  }, []);
  return <main className="auth-page"><section className="auth-card auth-loading">{error ? <><h1>Não foi possível concluir</h1><p>{error}</p><a className="button button-primary" href="/login">Voltar ao login</a></> : <><LoaderCircle size={24} className="spin" /><h1>Confirmando sua conta…</h1><p>Estamos preparando seu workspace.</p></>}</section></main>;
}
