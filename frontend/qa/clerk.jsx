import { createContext, useContext, useState } from 'react';

// Test-only Clerk stand-in, imported exclusively by vite.qa.config.mjs.
const Context = createContext(null);
export function ClerkProvider({ children }) {
  const params = new URLSearchParams(location.search);
  const [orgId, setOrg] = useState(params.get('org') || 'fixture-a');
  const role = params.get('role') || 'member';
  const getToken = async () => `fixture:${role}:${orgId}:${params.get('state') || ''}`;
  return <Context.Provider value={{ orgId, setOrg, role, getToken }}><div style={{ padding:8, background:'#fff0c2', color:'#332500', textAlign:'center' }}>LOCAL QA FIXTURES ONLY. No recovered or production assets.</div>{children}</Context.Provider>;
}
export function useAuth() { const c = useContext(Context); return { isLoaded:true, isSignedIn:true, userId:'fixture-user', orgId:c.orgId, orgSlug:c.orgId, orgRole:`org:${c.role}`, getToken:c.getToken }; }
export function useUser() { return { isLoaded:true, user:{ fullName:'Fixture Member', imageUrl:'/qa-avatar', primaryEmailAddress:{ emailAddress:'fixture@example.invalid' } } }; }
export function useClerk() { return { openUserProfile:() => alert('Fixture account menu'), signOut:async () => alert('Fixture sign out') }; }
export function Show({ when, children }) { return when === 'signed-in' ? children : null; }
export function OrganizationSwitcher() { const c = useContext(Context); return <button style={{ color:'#fff', minHeight:44 }} onClick={() => c.setOrg(c.orgId === 'fixture-a' ? 'fixture-b' : 'fixture-a')}>Switch fixture workspace</button>; }
export function UserButton() { return <span>FM</span>; }
export function SignIn() { return <p>Fixture sign in</p>; }
export function SignUp() { return <p>Fixture sign up</p>; }
export function SignInButton({ children }) { return children; }
export function SignUpButton({ children }) { return children; }
