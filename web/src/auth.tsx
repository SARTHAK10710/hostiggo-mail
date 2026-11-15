import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, session, setUnauthorizedHandler } from './api';

export interface Me {
  user: { id: string; email: string };
  active_workspace_id: string | null;
  workspaces: { id: string; name: string; role: 'owner' | 'admin' | 'member' | 'viewer' }[];
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  workspace: Me['workspaces'][number] | null;
  signIn(workspaceId: string | null): Promise<void>;
  signOut(): Promise<void>;
  switchWorkspace(id: string): void;
}

const Ctx = createContext<AuthState>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  // The session is an httpOnly cookie we cannot see, so we simply ask the server who we are.
  const [signedOut, setSignedOut] = useState(false);
  const meQ = useQuery({
    queryKey: ['me'],
    enabled: !signedOut,
    retry: false,
    queryFn: async () => {
      const me = await api<Me>('/v1/me');
      // Make sure the stored workspace is still one we belong to.
      if (!me.workspaces.some((w) => w.id === session.workspaceId)) session.setWorkspace(me.workspaces[0]?.id ?? '');
      return me;
    },
  });

  useEffect(() => {
    setUnauthorizedHandler(() => {
      session.clear();
      setSignedOut(true);
      qc.clear();
    });
  }, [qc]);

  const me = signedOut ? null : (meQ.data ?? null);
  const workspace = me?.workspaces.find((w) => w.id === session.workspaceId) ?? me?.workspaces[0] ?? null;

  const value: AuthState = {
    me,
    loading: !signedOut && meQ.isLoading,
    workspace,
    async signIn(workspaceId) {
      if (workspaceId) session.setWorkspace(workspaceId);
      setSignedOut(false);
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    async signOut() {
      try {
        await api('/v1/auth/logout', { method: 'POST' });
      } catch {
        /* already gone */
      }
      session.clear();
      setSignedOut(true);
      qc.clear();
    },
    switchWorkspace(id) {
      session.setWorkspace(id);
      qc.invalidateQueries();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const canEdit = (role?: string | null) => role === 'owner' || role === 'admin' || role === 'member';
export const isAdmin = (role?: string | null) => role === 'owner' || role === 'admin';
