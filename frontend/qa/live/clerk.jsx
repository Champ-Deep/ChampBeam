import { createContext, useContext, useState } from 'react';
import tokens from 'virtual:qa-tokens';

// LIVE-WORKER QA stand-in for Clerk. Tokens are test-key JWTs the local Worker verifies; nothing here touches production.
const Ctx = createContext(null);
const q = new URLSearchParams(location.search);
if (q.get('role')) sessionStorage.setItem('qa-role', q.get('role'));
export function ClerkProvider({ children }) {
  const [org, setOrg] = useState(sessionStorage.getItem('qa-org') || 'a');
  const role = sessionStorage.getItem('qa-role') || 'member';
  const eff = tokens[`${org}:${role}`] ? role : 'member';
  const getToken = async () => tokens[`${org}:${eff}`];
  const swap = () => { const n = org === 'a' ? 'b' : 'a'; sessionStorage.setItem('qa-org', n); setOrg(n); };
  return <Ctx.Provider value={{ org, role: eff, getToken, swap }}><div style={{ padding: 8, background: '#fff0c2', color: '#332500', textAlign: 'center' }}>LOCAL WORKER QA. Test-key tokens, local D1/R2 only.</div>{children}</Ctx.Provider>;
}
export function useAuth() { const c = useContext(Ctx); return { isLoaded: true, isSignedIn: true, userId: `user_qa_${c.org}_${c.role}`, orgId: `org_qa_${c.org}`, orgSlug: `qa-${c.org}`, orgRole: `org:${c.role}`, getToken: c.getToken }; }
export function useUser() { return { isLoaded: true, user: { fullName: 'QA Person', imageUrl: '/qa-avatar', primaryEmailAddress: { emailAddress: 'qa@qa.invalid' } } }; }
export function useClerk() { return { openUserProfile: () => alert('account menu'), signOut: async () => alert('sign out') }; }
export function Show({ when, children }) { return when === 'signed-in' ? children : null; }
export function OrganizationSwitcher() { const c = useContext(Ctx); return <button style={{ color: '#fff', minHeight: 44 }} onClick={c.swap}>Switch workspace</button>; }
export function UserButton() { return <span>QA</span>; }
export function SignIn() { return <p>sign in</p>; }
export function SignUp() { return <p>sign up</p>; }
export function SignInButton({ children }) { return children; }
export function SignUpButton({ children }) { return children; }
