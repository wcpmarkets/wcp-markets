"use client";

import { useActionState } from "react";
import { adminLogin, type LoginState } from "../actions";

export function LoginForm({ notice }: { notice: string | null }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(adminLogin, { step: "phone" });

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted">WCP Markets</p>
      <h1 className="mt-2 text-2xl font-bold">Staff console</h1>
      <p className="mt-2 text-sm text-muted">Sign in with the phone number on your WCP account. Only staff accounts get in.</p>

      <form action={action} className="mt-8 flex flex-col gap-3">
        {state.step === "phone" ? (
          <label className="flex flex-col gap-1.5 text-sm">
            Phone number
            <input
              name="phone"
              inputMode="tel"
              autoComplete="tel"
              placeholder="0803 000 0000"
              required
              className="rounded-lg border border-line bg-panel px-3 py-2.5 text-base outline-none focus:border-brand-cyan"
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1.5 text-sm">
            Code sent to {state.phone}
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              required
              autoFocus
              className="rounded-lg border border-line bg-panel px-3 py-2.5 text-base tracking-widest outline-none focus:border-brand-cyan"
            />
          </label>
        )}
        {(state.error || (!state.error && state.step === "phone" && notice)) && (
          <p role="alert" className="text-sm text-[#e5645a]">{state.error ?? notice}</p>
        )}
        <button
          disabled={pending}
          className="mt-1 rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-canvas disabled:opacity-60"
        >
          {pending ? "…" : state.step === "phone" ? "Send code" : "Sign in"}
        </button>
        {state.step === "code" && (
          <a href="/admin/login" className="text-center text-sm text-muted underline">Use a different number</a>
        )}
      </form>
    </main>
  );
}
