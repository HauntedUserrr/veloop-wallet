import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { onSessionExpired, request } from './api.js';
import { ErrorMessage, Loading, useApi } from './components.jsx';
import Wallet from './Wallet.jsx';
import Payout from './Payout.jsx';
import './styles.css';

const sessionKey = 'veloop-demo-session';

function readSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(sessionKey));
    return typeof value?.token === 'string' && typeof value?.user?.id === 'string' ? value : null;
  } catch {
    return null;
  }
}

function Login({ signIn }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const access = useApi(null, '/auth/demo');
  const { publicDemo, evaluatorAccess } = access.data ?? {};

  async function start(path, body) {
    setBusy(true);
    setError(null);
    try {
      const session = await request(path, { method: 'POST', body });
      signIn({ token: session.token, user: session.user });
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }

  function startAsEvaluator(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const accessCode = new FormData(form).get('accessCode');
    form.reset();
    void start('/auth/demo/evaluator', { accessCode });
  }

  return <section className="login panel">
    <h1>Demo wallet</h1>
    <ErrorMessage error={access.error} retry={access.reload} />
    <ErrorMessage error={error} />
    {!access.data && !access.error && <Loading />}
    {access.data && !publicDemo && !evaluatorAccess && <p>Demo sign-in is unavailable.</p>}
    {publicDemo && <button type="button" className="button primary" disabled={busy} onClick={() => start('/auth/demo', {})}>
      {busy ? 'Opening wallet…' : 'Start demo'}
    </button>}
    {evaluatorAccess && <details className="evaluator-access" open={!publicDemo || undefined}>
      <summary>Evaluator access</summary>
      <form className="payout-form" onSubmit={startAsEvaluator}>
        <div className="field">
          <label htmlFor="evaluator-code">Access code</label>
          <input id="evaluator-code" name="accessCode" type="password" autoComplete="off" required maxLength={128} />
        </div>
        <button type="submit" className="button" disabled={busy}>Open evaluator wallet</button>
      </form>
    </details>}
  </section>;
}

function App() {
  const [session, setSession] = useState(readSession);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(null);
  const navigate = useNavigate();
  const location = useLocation();
  const destination = location.state?.returnTo === '/payout' ? '/payout' : '/wallet';

  function signIn(value) {
    setSignOutError(null);
    sessionStorage.setItem(sessionKey, JSON.stringify(value));
    setSession(value);
    navigate(destination, { replace: true });
  }

  const clearSession = useCallback(() => {
    sessionStorage.removeItem(sessionKey);
    setSession(null);
    setSignOutError(null);
    navigate('/login', { replace: true });
  }, [navigate]);

  useEffect(() => onSessionExpired(event => {
    if (event.detail === session?.token) clearSession();
  }), [clearSession, session?.token]);

  async function signOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await request('/auth/logout', { token: session.token, method: 'POST' });
      clearSession();
    } catch (error) {
      if (error.status !== 401 && error.code !== 'ACCOUNT_SUSPENDED') {
        setSignOutError(new Error('Could not end the session. Please try signing out again.'));
      }
    } finally {
      setSigningOut(false);
    }
  }

  return <>
    <a className="skip" href="#main">Skip to content</a>
    <header className="topbar">
      <div className="shell topbar-inner">
        <NavLink className="brand" to={session ? '/wallet' : '/login'}>
          VELoop Rewards
        </NavLink>
        {session && <>
          <nav aria-label="Main navigation">
            <NavLink to="/wallet">Wallet</NavLink>
            <NavLink to="/payout">Payout</NavLink>
          </nav>
          <button className="button signout" type="button" disabled={signingOut} onClick={signOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </>}
      </div>
    </header>
    <main id="main" className="shell main" tabIndex={-1}>
      <ErrorMessage error={signOutError} />
      <Routes>
        <Route path="/login" element={session ? <Navigate to={destination} replace /> : <Login signIn={signIn} />} />
        <Route path="/wallet" element={session ? <Wallet token={session.token} /> : <Navigate to="/login" replace />} />
        <Route path="/payout" element={session
          ? <Payout token={session.token} userId={session.user.id} isDemo={session.user.demo} />
          : <Navigate to="/login" state={{ returnTo: '/payout' }} replace />} />
        <Route path="*" element={<Navigate to={session ? '/wallet' : '/login'} replace />} />
      </Routes>
    </main>
  </>;
}

createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>);
