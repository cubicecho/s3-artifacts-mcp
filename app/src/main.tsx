import { ApolloProvider } from '@apollo/client/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router';
import { RequireAuth } from '@/components/layouts/require-auth';
import { useThemePreference } from '@/components/ui/theme-preference';
import { TooltipProvider } from '@/components/ui/tooltip';
import { apolloClient } from '@/lib/apollo';
import { ROUTES } from '@/lib/routes';
import { DocumentRoute } from '@/routes/document';
import { DocumentsRoute } from '@/routes/documents';
import { LoginPage } from '@/routes/login';
import { SettingsRoute } from '@/routes/settings';
import { SsoPage } from '@/routes/sso';
import { VerifyPage } from '@/routes/verify';
import './index.css';

/**
 * index.html has already painted the theme by now; this is what keeps it right
 * afterwards. While the preference is `system`, flipping the OS between light
 * and dark repaints the app without a reload.
 */
function ThemeSync() {
  useThemePreference();
  return null;
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('index.html has no #root element to mount the app in');
}

createRoot(root).render(
  <StrictMode>
    <ApolloProvider client={apolloClient}>
      <TooltipProvider>
        <ThemeSync />
        <BrowserRouter>
          <Routes>
            <Route path={ROUTES.login} element={<LoginPage />} />
            <Route path={ROUTES.verify} element={<VerifyPage />} />
            <Route path={ROUTES.sso} element={<SsoPage />} />
            {/* One layout route around every signed-in page, so the sidebar, and the buckets opened
                in its tree, stay mounted while the reader moves between pages. */}
            <Route element={<RequireAuth contentSlot={<Outlet />} />}>
              <Route path={ROUTES.documents} element={<DocumentsRoute />} />
              <Route path={ROUTES.document} element={<DocumentRoute />} />
              <Route path={ROUTES.settings} element={<SettingsRoute />} />
            </Route>
            <Route path="*" element={<Navigate to={ROUTES.documents} replace />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </ApolloProvider>
  </StrictMode>,
);
