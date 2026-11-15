import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import './index.css';
import { AuthProvider, useAuth } from './auth';
import { AppLayout } from './layout';
import { LoginPage } from './pages/login';
import { Spinner, ToastProvider } from './ui';

// Route-level code splitting: each page is fetched when first opened, so the first load stays small.
const OverviewPage = lazy(() => import('./pages/overview').then((m) => ({ default: m.OverviewPage })));
const AutomationsPage = lazy(() => import('./pages/automations').then((m) => ({ default: m.AutomationsPage })));
const AutomationBuilder = lazy(() => import('./pages/automations').then((m) => ({ default: m.AutomationBuilder })));
const TransactionalPage = lazy(() => import('./pages/transactional').then((m) => ({ default: m.TransactionalPage })));
const MarketingPage = lazy(() => import('./pages/marketing').then((m) => ({ default: m.MarketingPage })));
const DeliverabilityPage = lazy(() => import('./pages/deliverability').then((m) => ({ default: m.DeliverabilityPage })));
const ContactsPage = lazy(() => import('./pages/contacts').then((m) => ({ default: m.ContactsPage })));
const TemplatesPage = lazy(() => import('./pages/templates').then((m) => ({ default: m.TemplatesPage })));
const SettingsPage = lazy(() => import('./pages/settings').then((m) => ({ default: m.SettingsPage })));

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
