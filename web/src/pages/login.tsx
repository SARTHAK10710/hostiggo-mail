import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Logo } from '../layout';
import { Button, ErrorBox, Field, Spinner, Tabs } from '../ui';

/** Token from a /invite/<token> link, if the page was opened from an invitation. */
const inviteToken = () => window.location.pathname.match(/^\/invite\/([A-Za-z0-9_-]{10,200})$/)?.[1] ?? null;

export function LegalLinks({ className = '' }: { className?: string }) {
  return (
    <div className={`flex gap-3 text-[11px] ${className}`}>
      <a href="/privacy" className="hover:underline">Privacy</a>
      <a href="/terms" className="hover:underline">Terms</a>
      <a href="/support" className="hover:underline">Support</a>
    </div>
  );
}

export function LoginPage() {
  const { signIn } = useAuth();
  const token = inviteToken();
  const [mode, setMode] = useState<'login' | 'signup'>(token ? 'signup' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState('Hostiggo');
  const [name, setName] = useState('');

  const authConfig = useQuery({ queryKey: ['auth-config'], queryFn: () => api<{ allow_signups: boolean }>('/v1/auth/config') });
  const invite = useQuery({
    queryKey: ['invite', token],
    enabled: !!token,
    retry: false,
    queryFn: () => api<{ email: string; role: string; workspace_name: string }>(`/v1/invites/lookup?token=${encodeURIComponent(token!)}`),
  });
  const signupsOpen = authConfig.data?.allow_signups !== false;

  const m = useMutation({
    mutationFn: async () => {
      if (invite.data) {
        const r = await api('/v1/auth/signup', { body: { email: invite.data.email, password, name: name || undefined, invite_token: token } });
        return { token: r.session.token, ws: r.workspace.id };
      }
      if (mode === 'signup') {
        const r = await api('/v1/auth/signup', { body: { email, password, name: name || undefined, workspace_name: workspace } });
        return { token: r.session.token, ws: r.workspace.id };
      }
      const r = await api('/v1/auth/login', { body: { email, password } });
      return { token: r.session.token, ws: null };
    },
    onSuccess: ({ token: t, ws }) => {
      if (inviteToken()) window.history.replaceState({}, '', '/');
      return signIn(t, ws);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };

  const joining = !!invite.data;
  const title = joining ? `Join ${invite.data!.workspace_name}` : mode === 'login' ? 'Sign in' : 'Create your workspace';
  const subtitle = joining
    ? `You were invited as ${invite.data!.role}. Choose a password to finish.`
    : mode === 'login' ? 'Welcome back.' : 'You will be the owner of a new workspace.';

  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_1.1fr]">
      <div className="hidden flex-col justify-between bg-shell p-10 text-slate-300 lg:flex">
        <Logo />
        <div className="max-w-md space-y-4">
          <h1 className="text-[28px] font-semibold leading-9 tracking-tight text-white">Lifecycle email, sent from your own Gmail.</h1>
          <p className="text-[15px] leading-6">Connect a mailbox, import permission-based contacts, publish an automation, and see which messages were accepted, bounced and answered.</p>
          <ul className="space-y-2 text-[13px]">
            {['Gmail OAuth with least-privilege scopes', 'Consent + suppression checked before every send', 'Reply rate with a visible numerator, denominator and window'].map((t) => (
              <li key={t} className="flex items-center gap-2"><span className="size-1.5 rounded-full bg-emerald-400" />{t}</li>
            ))}
          </ul>
        </div>
        <div className="flex items-center justify-between text-slate-500">
          <span className="text-[11px]">Hostiggo Mail · Operations console</span>
          <LegalLinks />
        </div>
      </div>
      <div className="flex flex-col items-center justify-center gap-4 p-6">
        {token && invite.isLoading ? <Spinner label="Checking your invitation…" /> : (
          <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
            <div className="lg:hidden"><div className="inline-block rounded-lg bg-shell p-3"><Logo /></div></div>
            <div>
              <h2 className="text-[18px] font-semibold">{title}</h2>
              <p className="text-[12px] text-muted">{subtitle}</p>
            </div>
            {token && invite.isError && <ErrorBox error="This invitation link is invalid, already used or expired. Ask your workspace admin for a new one." />}
            {!joining && (
              <Tabs value={mode} onChange={(v) => { setMode(v); m.reset(); }} items={[{ value: 'login', label: 'Sign in' }, { value: 'signup', label: 'Create account' }]} />
            )}
            {!joining && mode === 'signup' && !signupsOpen ? (
              <div className="rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-[12px] text-orange-800">
                Sign-up on this server is by invitation only. Ask a workspace admin to invite you (Settings → Members); you'll get a link to join.
              </div>
            ) : (
              <>
                {(joining || mode === 'signup') && <Field label="Your name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>}
                {!joining && mode === 'signup' && <Field label="Workspace name"><input className="input" required value={workspace} onChange={(e) => setWorkspace(e.target.value)} /></Field>}
                <Field label="Email">
                  {joining
                    ? <input className="input bg-canvas" type="email" value={invite.data!.email} readOnly />
                    : <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />}
                </Field>
                <Field label="Password" hint={joining || mode === 'signup' ? 'At least 10 characters.' : undefined}>
                  <input className="input" type="password" required minLength={joining || mode === 'signup' ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={joining || mode === 'signup' ? 'new-password' : 'current-password'} />
                </Field>
                <ErrorBox error={m.error} />
                <Button variant="primary" className="w-full" loading={m.isPending} type="submit">
                  {joining ? 'Join workspace' : mode === 'login' ? 'Sign in' : 'Create workspace'}
                </Button>
              </>
            )}
          </form>
        )}
        <LegalLinks className="text-muted lg:hidden" />
      </div>
    </div>
  );
}
