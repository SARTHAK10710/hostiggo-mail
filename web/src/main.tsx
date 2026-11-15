import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import './index.css';
import { AuthProvider, useAuth } from './auth';
import { AppLayout } from './layout';
import { AutomationBuilder, AutomationsPage } from './pages/automations';
import { ContactsPage } from './pages/contacts';
import { DeliverabilityPage } from './pages/deliverability';
import { LoginPage } from './pages/login';
import { MarketingPage } from './pages/marketing';
import { OverviewPage } from './pages/overview';
import { SettingsPage } from './pages/settings';
import { TemplatesPage } from './pages/templates';
import { TransactionalPage } from './pages/transactional';
import { Spinner, ToastProvider } from './ui';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function Gate({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!me) return <LoginPage />;
  return <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <Gate>
              <Routes>
                <Route element={<AppLayout />}>
                  <Route index element={<OverviewPage />} />
                  <Route path="automations" element={<AutomationsPage />} />
                  <Route path="automations/:id" element={<AutomationBuilder />} />
                  <Route path="transactional" element={<TransactionalPage />} />
                  <Route path="marketing" element={<MarketingPage />} />
                  <Route path="deliverability" element={<DeliverabilityPage />} />
                  <Route path="contacts" element={<ContactsPage />} />
                  <Route path="templates" element={<TemplatesPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="settings/:section" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </Gate>
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
