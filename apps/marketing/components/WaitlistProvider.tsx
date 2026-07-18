"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
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
 *
 * Flow: `requestJoin` validates the email and opens the intent dialog;
 * `confirmIntent` (from the dialog) sends the sign-up with the chosen intent.
 */
type WaitlistContextValue = {
  email: string;
  setEmail: (value: string) => void;
  joined: boolean;
  submitting: boolean;
  error: string | null;
  clearError: () => void;
  dialogOpen: boolean;
  submitError: string | null;
  requestJoin: (source: "hero" | "waitlist") => void;
  confirmIntent: (value: Exclude<WaitlistIntent, null>) => Promise<void>;
  closeDialog: () => void;
};

const WaitlistContext = createContext<WaitlistContextValue | null>(null);

export function WaitlistProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState("");
  const [joined, setJoined] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const sourceRef = useRef<"hero" | "waitlist">("hero");

  const clearError = useCallback(() => setError(null), []);

  // Step 1 — validate the email, then open the intent dialog.
  const requestJoin = useCallback(
    (source: "hero" | "waitlist") => {
      if (submitting || joined) return;
      // Minimal validation (accept if it contains "@"). The error surfaces inline
      // in the field as a red placeholder, so clear the invalid value.
      if (!email.includes("@")) {
        setError("Enter a valid email address");
        setEmail("");
        return;
      }
      setError(null);
      setSubmitError(null);
      sourceRef.current = source;
      track("waitlist_submit", { source });
      setDialogOpen(true);
    },
    [email, joined, submitting],
  );

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setSubmitError(null);
  }, []);

  // Step 2 — the dialog picked an intent; send the sign-up.
  const confirmIntent = useCallback(
    async (value: Exclude<WaitlistIntent, null>) => {
      if (submitting) return;
      setSubmitting(true);
      setSubmitError(null);
      const source = sourceRef.current;
      track("waitlist_intent", { source, intent: value });
      try {
        const res = await joinWaitlist({ email, intent: value });
        if (res.ok) {
          setJoined(true);
          setDialogOpen(false);
          track("waitlist_success", {
            source,
            intent: value,
            duplicate: res.duplicate,
          });
        } else {
          setSubmitError("Something went wrong — please try again");
        }
      } catch {
        setSubmitError("Something went wrong — please try again");
      } finally {
        setSubmitting(false);
      }
    },
    [email, submitting],
  );

  const value = useMemo<WaitlistContextValue>(
    () => ({
      email,
      setEmail,
      joined,
      submitting,
      error,
      clearError,
      dialogOpen,
      submitError,
      requestJoin,
      confirmIntent,
      closeDialog,
    }),
    [
      email,
      joined,
      submitting,
      error,
      clearError,
      dialogOpen,
      submitError,
      requestJoin,
      confirmIntent,
      closeDialog,
    ],
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
