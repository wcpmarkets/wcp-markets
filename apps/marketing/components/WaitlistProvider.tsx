"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { track } from "@wcp/analytics";
import { joinWaitlist } from "@/app/actions/waitlist";
import type { WaitlistIntent } from "@/lib/waitlist";

/**
 * Shared waitlist state (F-1). One provider wraps the page so the hero and the
 * waitlist section read/write the same email + joined state — submitting in
 * either place flips both.
 */
type WaitlistContextValue = {
  email: string;
  setEmail: (value: string) => void;
  intent: WaitlistIntent;
  setIntent: (value: WaitlistIntent) => void;
  joined: boolean;
  submitting: boolean;
  error: string | null;
  clearError: () => void;
  submit: (source: "hero" | "waitlist") => Promise<void>;
};

const WaitlistContext = createContext<WaitlistContextValue | null>(null);

export function WaitlistProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState("");
  const [intent, setIntent] = useState<WaitlistIntent>(null);
  const [joined, setJoined] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (source: "hero" | "waitlist") => {
      if (submitting || joined) return;
      // Minimal validation, matching the prototype (accept if it contains "@").
      // The error surfaces inline in the field (as a red placeholder), so clear
      // the invalid value to make it visible.
      if (!email.includes("@")) {
        setError("Enter a valid email address");
        setEmail("");
        return;
      }
      setError(null);
      setSubmitting(true);
      track("waitlist_submit", { source, intent });
      try {
        const res = await joinWaitlist({ email, intent });
        if (res.ok) {
          setJoined(true);
          track("waitlist_success", { source, duplicate: res.duplicate, intent });
        } else {
          setError(
            res.error === "invalid_email"
              ? "Enter a valid email address"
              : "Something went wrong — try again",
          );
          setEmail("");
        }
      } catch {
        setError("Something went wrong — try again");
        setEmail("");
      } finally {
        setSubmitting(false);
      }
    },
    [email, intent, joined, submitting],
  );

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<WaitlistContextValue>(
    () => ({
      email,
      setEmail,
      intent,
      setIntent,
      joined,
      submitting,
      error,
      clearError,
      submit,
    }),
    [email, intent, joined, submitting, error, clearError, submit],
  );

  return (
    <WaitlistContext.Provider value={value}>
      {children}
    </WaitlistContext.Provider>
  );
}

export function useWaitlist(): WaitlistContextValue {
  const ctx = useContext(WaitlistContext);
  if (!ctx) throw new Error("useWaitlist must be used within a WaitlistProvider");
  return ctx;
}
