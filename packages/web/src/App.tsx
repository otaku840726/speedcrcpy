import { useEffect, useState } from "react";
import { api } from "./api";
import { DeviceList } from "./pages/DeviceList";
import { Login } from "./pages/Login";
import { Session } from "./pages/Session";

type AuthState = "checking" | "unauthenticated" | "authenticated";

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [sessionSerial, setSessionSerial] = useState<string | undefined>(undefined);

  useEffect(() => {
    api("/api/me")
      .then(() => setAuthState("authenticated"))
      .catch(() => setAuthState("unauthenticated"));
  }, []);

  if (authState === "checking") return null;
  if (authState === "unauthenticated") return <Login onSuccess={() => setAuthState("authenticated")} />;
  if (sessionSerial !== undefined) {
    return <Session serial={sessionSerial} onBack={() => setSessionSerial(undefined)} />;
  }
  return <DeviceList onOpenSession={setSessionSerial} />;
}
