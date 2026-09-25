import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, postJson, UNAUTHORIZED_EVENT } from "../../api/client.js";
import { Button, Card, Spinner } from "../../ui/ui.js";

export interface Session {
  authRequired: boolean;
  authenticated: boolean;
}

export const sessionKey = ["session"] as const;

export const useSession = () =>
  useQuery({
    queryKey: sessionKey,
    queryFn: () => api<Session>("/session"),
    retry: false,
    staleTime: Infinity,
  });

/** Re-check the session whenever the API answers 401 (the key changed, the cookie expired). */
function useUnauthorizedListener(): void {
  const client = useQueryClient();
  useEffect(() => {
    const onUnauthorized = () => void client.invalidateQueries({ queryKey: sessionKey });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [client]);
}

/**
 * Shows the sign-in form when the API needs a key and this browser has no session; otherwise
 * the page. If the session cannot be read (an older API, the API is down), the page is shown
 * and reports its own errors.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  useUnauthorizedListener();
  const session = useSession();
  if (session.isPending) return <Spinner label="Connecting" />;
  if (session.data?.authRequired === true && !session.data.authenticated) return <SignIn />;
  return <>{children}</>;
}

export function SignIn() {
  const client = useQueryClient();
  const [key, setKey] = useState("");
  const signIn = useMutation({
    mutationFn: (k: string) => postJson<unknown>("/session", { key: k }),
    onSuccess: async () => {
      setKey("");
      await client.invalidateQueries();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim() !== "") signIn.mutate(key.trim());
  };
  const error =
    signIn.error instanceof ApiError && signIn.error.status === 401
      ? "That key is not right."
      : signIn.error !== null
        ? "Could not sign in. Is the API running?"
        : null;
  return (
    <div className="sign-in">
      <Card title="Sign in">
        <form onSubmit={submit} className="form" noValidate>
          <p className="field-hint">
            This LinkLens server needs its API key (the <code>LINKLENS_API_KEY</code> it was started
            with). It is exchanged for a session cookie and not stored in the page.
          </p>
          <div className="field">
            <label htmlFor="api-key">API key</label>
            <input
              id="api-key"
              type="password"
              autoComplete="current-password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              aria-invalid={error !== null}
              aria-describedby={error !== null ? "api-key-error" : undefined}
            />
            {error !== null && (
              <div id="api-key-error" className="field-error" role="alert">
                {error}
              </div>
            )}
          </div>
          <Button type="submit" disabled={signIn.isPending || key.trim() === ""}>
            {signIn.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}

/** "Sign out" in the header, when the server needs a key and this browser is signed in. */
export function SignOut() {
  const client = useQueryClient();
  const session = useSession();
  const signOut = useMutation({
    mutationFn: () => fetchSignOut(),
    onSuccess: async () => {
      // Forget every result shown so far, then ask the server again.
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== sessionKey[0] });
      await client.invalidateQueries({ queryKey: sessionKey });
    },
  });
  if (session.data?.authRequired !== true || !session.data.authenticated) return null;
  return (
    <Button variant="secondary" className="sign-out" onClick={() => signOut.mutate()}>
      Sign out
    </Button>
  );
}

const fetchSignOut = () => api<unknown>("/session", { method: "DELETE" });
