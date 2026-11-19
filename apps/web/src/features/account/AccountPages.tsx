import { useAuth0 } from '@auth0/auth0-react';
import { useState } from 'react';
import { hasAuth0Configuration } from '../../auth/AuthProvider';
import { OperationsHeading } from '../../components/workspace/OperationsLayout';
import { clearNotificationWorkspace } from '../notifications/api';
import { Icon } from '../../lib/icons';

const passwordPath = '/account/password';

function Auth0PasswordChange() {
  const { isLoading, isAuthenticated, loginWithRedirect, user } = useAuth0();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const { VITE_AUTH0_DOMAIN: domain, VITE_AUTH0_CLIENT_ID: clientId, VITE_AUTH0_DB_CONNECTION: connection } = import.meta.env;
  const email = user?.email;

  async function sendReset() {
    if (!email || !connection || sending || sent) return;
    setSending(true);
    setError('');
    try {
      const response = await fetch(`https://${domain}/dbconnections/change_password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, email, connection }),
      });
      if (!response.ok) throw new Error('Password reset request failed.');
      setSent(true);
    } catch {
      setError('Could not send the reset email. Try again later.');
    } finally {
      setSending(false);
    }
  }

  if (isLoading) return <p role="status">Checking your session…</p>;
  if (!isAuthenticated) return <>
    <p>Sign in to manage your password.</p>
    <button className="button button--primary" type="button" onClick={() =>
      void loginWithRedirect({ appState: { returnTo: passwordPath } }).catch(() => setError('Could not open the sign-in page.'))}>
      Sign in
    </button>
    {error && <p role="alert">{error}</p>}
  </>;

  if (!user?.sub?.startsWith('auth0|')) return <p>Change your password with the provider you use to sign in.</p>;
  if (!connection || !email) return <p>Password reset is unavailable for this account. Contact your workspace administrator.</p>;

  return <>
    <form className="account-reset-form" onSubmit={(event) => { event.preventDefault(); void sendReset(); }}>
      <label>Sign-in email<input type="email" value={email} readOnly /></label>
      <button className="button button--primary" type="submit" disabled={sending || sent}>
        {sending ? 'Sending…' : sent ? 'Reset email requested' : 'Send password reset email'}
      </button>
    </form>
    {sent && <p role="status">Check your email for the password reset link.</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}

export default function ChangePasswordPage({ onProfile }: { onProfile: () => void }) {
  return <div className="operations-page account-page">
    <div className="account-password-page">
      <OperationsHeading section="Account security" title="Change password" description="Manage the password you use to sign in to Flowdeck." />
      <section className="operations-card account-password">
        <span className="operations-tile"><Icon name="key" /></span>
        {hasAuth0Configuration() ? <Auth0PasswordChange /> : <>
          <p>The local demo account has no password to change.</p>
          <button className="button button--secondary" type="button" onClick={onProfile}>Back to my profile</button>
        </>}
      </section>
    </div>
  </div>;
}

function SignOutConfirmation({ onCancel, onSignOut, busy, error, local }: {
  onCancel: () => void; onSignOut: () => void; busy?: boolean; error?: string; local?: boolean;
}) {
  return <div className="operations-page account-page">
    <section className="operations-card account-logout">
      <span className="operations-tile"><Icon name="logout" /></span>
      <h1>Sign out of Flowdeck?</h1>
      <p>{local ? 'This ends the local demo session in this tab.' : 'You’ll need to sign in again to access workspace data.'}</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="operations-actions">
        <button type="button" className="button button--secondary" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="button button--primary" disabled={busy} onClick={onSignOut}>
          {busy ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </section>
  </div>;
}

function Auth0LogoutPage({ onCancel }: { onCancel: () => void }) {
  const { logout, isAuthenticated, isLoading } = useAuth0();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function signOut() {
    if (busy || isLoading) return;
    setError('');
    setBusy(true);
    clearNotificationWorkspace();
    if (!isAuthenticated) {
      window.location.replace('/signed-out');
      return;
    }
    try {
      await logout({ logoutParams: { returnTo: `${window.location.origin}/signed-out` } });
    } catch {
      setError('Could not sign out. Try again.');
      setBusy(false);
    }
  }

  return <SignOutConfirmation onCancel={onCancel} onSignOut={() => void signOut()} busy={busy || isLoading} error={error} />;
}

export function LogoutPage({ onCancel, onLocalLogout }: { onCancel: () => void; onLocalLogout: () => void }) {
  return hasAuth0Configuration() ? <Auth0LogoutPage onCancel={onCancel} /> :
    <SignOutConfirmation local onCancel={onCancel} onSignOut={onLocalLogout} />;
}

function Auth0SignIn() {
  const { loginWithRedirect } = useAuth0();
  const [error, setError] = useState('');
  return <>
    <button className="button button--primary" type="button" onClick={() =>
      void loginWithRedirect({ appState: { returnTo: '/dashboard' } }).catch(() => setError('Could not open the sign-in page.'))}>
      Sign in
    </button>
    {error && <p role="alert">{error}</p>}
  </>;
}

export function SignedOutPage({ onResumeDemo }: { onResumeDemo: () => void }) {
  return <main className="signed-out">
    <section className="operations-card">
      <span className="operations-tile"><Icon name="logout" /></span><h1>You’re signed out</h1>
      {hasAuth0Configuration() ? <Auth0SignIn /> :
        <button className="button button--primary" type="button" onClick={onResumeDemo}>Return to local workspace</button>}
    </section>
  </main>;
}
