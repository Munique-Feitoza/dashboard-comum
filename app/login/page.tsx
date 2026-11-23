'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, LoaderCircle, LockKeyhole, Mail } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState('Minha empresa');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(''); setMessage('');
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError('Autenticação ainda não configurada. Adicione as variáveis NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'login') {
        const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError) throw authError;
        window.location.assign('/');
        return;
      }
      localStorage.setItem('monetize-new-workspace', workspace.trim());
      const { data, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (authError) throw authError;
      if (!data.session) {
        setMessage('Confira seu e-mail para confirmar a conta. Depois do link de confirmação, seu workspace será criado.');
        return;
      }
      const { error: workspaceError } = await supabase.rpc('create_workspace', { workspace_name: workspace.trim() });
      if (workspaceError) throw workspaceError;
      localStorage.removeItem('monetize-new-workspace');
      window.location.assign('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível autenticar. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  return <main className="auth-page"><Link href="/" className="auth-back"><ArrowLeft size={15} />Voltar ao dashboard</Link><section className="auth-card"><div className="auth-brand"><span className="brand-mark"><span className="brand-glyph"><span /><span /><span /></span></span><span className="brand-name">monetize<span className="brand-dot">.</span></span></div><div className="auth-heading"><span className="auth-kicker">WORKSPACE · AGÊNCIA AURORA</span><h1>{mode === 'login' ? 'Entre na sua conta' : 'Crie seu workspace'}</h1><p>{mode === 'login' ? 'Acesse seus dados de monetização.' : 'Comece a organizar suas propriedades e equipe.'}</p></div><form className="auth-form" onSubmit={submit}>{mode === 'signup' && <label className="form-field"><span>Nome da empresa</span><input required minLength={2} maxLength={100} autoComplete="organization" value={workspace} onChange={event => setWorkspace(event.target.value)} /></label>}<label className="form-field"><span>E-mail</span><div className="auth-input"><Mail size={15} /><input required type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="voce@empresa.com.br" /></div></label><label className="form-field"><span>Senha</span><div className="auth-input"><LockKeyhole size={15} /><input required type="password" minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} placeholder="Mínimo de 8 caracteres" /></div></label>{error && <div className="auth-message auth-error" role="alert">{error}</div>}{message && <div className="auth-message auth-success" role="status">{message}</div>}<button className="button button-primary auth-submit" disabled={loading}>{loading && <LoaderCircle size={15} className="spin" />}{loading ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Criar conta'}</button></form><div className="auth-switch">{mode === 'login' ? 'Ainda não tem conta?' : 'Já tem uma conta?'} <button onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setMessage(''); }}>{mode === 'login' ? 'Criar conta' : 'Entrar'}</button></div><div className="auth-demo-hint">A demo pública continua disponível sem login. O fluxo de autenticação precisa de um projeto Supabase configurado.</div></section><footer className="auth-footer">© 2026 Monetize · Acesso seguro ao seu workspace</footer></main>;
}
