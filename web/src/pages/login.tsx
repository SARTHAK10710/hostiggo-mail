import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Logo } from '../layout';
import { Button, ErrorBox, Field, Tabs } from '../ui';

export function LoginPage() {
  const { signIn } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState('Hostiggo');
  const [name, setName] = useState('');

  const m = useMutation({
    mutationFn: async () => {
      if (mode === 'signup') {
        const r = await api('/v1/auth/signup', { body: { email, password, name: name || undefined, workspace_name: workspace } });
        return r.workspace.id as string;
      }
      await api('/v1/auth/login', { body: { email, password } });
      return null;
    },
    onSuccess: (ws) => signIn(ws),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };

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
        <div className="text-[11px] text-slate-500">Hostiggo Mail · Operations console</div>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
          <div className="lg:hidden"><div className="inline-block rounded-lg bg-shell p-3"><Logo /></div></div>
          <div>
            <h2 className="text-[18px] font-semibold">{mode === 'login' ? 'Sign in' : 'Create your workspace'}</h2>
            <p className="text-[12px] text-muted">{mode === 'login' ? 'Welcome back.' : 'You will be the owner of a new workspace.'}</p>
          </div>
          <Tabs value={mode} onChange={(v) => { setMode(v); m.reset(); }} items={[{ value: 'login', label: 'Sign in' }, { value: 'signup', label: 'Create account' }]} />
          {mode === 'signup' && (
            <>
              <Field label="Your name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
              <Field label="Workspace name"><input className="input" required value={workspace} onChange={(e) => setWorkspace(e.target.value)} /></Field>
            </>
          )}
          <Field label="Email"><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
          <Field label="Password" hint={mode === 'signup' ? 'At least 10 characters.' : undefined}>
            <input className="input" type="password" required minLength={mode === 'signup' ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
          </Field>
          <ErrorBox error={m.error} />
          <Button variant="primary" className="w-full" loading={m.isPending} type="submit">
            {mode === 'login' ? 'Sign in' : 'Create workspace'}
          </Button>
        </form>
      </div>
    </div>
  );
}
