import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface SystemInfo {
  provider_mode: 'gmail' | 'fake';
  delivers_real_email: boolean;
  google_configured: boolean;
  reply_tracking_enabled: boolean;
  pubsub_configured: boolean;
  oauth_redirect_uri: string;
  gmail_default_daily_limit: number;
  gmail_max_campaign_recipients: number;
  reply_attribution_days: number;
  api_base_url: string;
  one_click_unsubscribe: boolean;
  unsubscribe_footer: boolean;
}
export interface Mailbox {
  id: string;
  email: string;
  display_name: string | null;
  status: 'active' | 'reauth_required' | 'error' | 'disconnected';
  health: 'healthy' | 'unhealthy';
  last_error: string | null;
  daily_send_limit: number;
  sent_last_24h: number;
  reply_tracking: boolean;
  watch_expires_at: string | null;
  last_synced_at: string | null;
  created_at: string;
}
export interface Template {
  id: string;
  name: string;
  kind: 'transactional' | 'marketing';
  current_version: number;
  subject: string;
  variables: string[];
  updated_at: string;
  slug?: string | null;
  sample_variables?: Record<string, unknown>;
}
export interface ContactList {
  id: string;
  name: string;
  description: string | null;
  member_count: number;
}

export const useSystem = () => useQuery({ queryKey: ['system'], queryFn: () => api<SystemInfo>('/v1/system'), staleTime: 60_000 });
export const useMailboxes = () =>
  useQuery({ queryKey: ['mailboxes'], queryFn: async () => (await api<{ data: Mailbox[] }>('/v1/mailboxes')).data, refetchInterval: 30_000 });
export const useActiveMailboxes = () => {
  const q = useMailboxes();
  return { ...q, data: q.data?.filter((m) => m.status === 'active') };
};
export const useTemplates = (kind?: string) =>
  useQuery({ queryKey: ['templates', kind ?? 'all'], queryFn: async () => (await api<{ data: Template[] }>(`/v1/templates${kind ? `?kind=${kind}` : ''}`)).data });
export const useLists = () => useQuery({ queryKey: ['lists'], queryFn: async () => (await api<{ data: ContactList[] }>('/v1/lists')).data });
