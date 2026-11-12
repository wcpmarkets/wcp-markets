"use client";

import { useState, useTransition } from "react";
import { GradientButton, cn } from "@wcp/ui";
import {
  confirmDeletion,
  sendDeletionCode,
  verifyDeletionCode,
  type Blocker,
} from "@/app/actions/delete-account";

type Step =
  | { s: "phone" }
  | { s: "code"; phone: string }
  | { s: "review"; token: string; canDelete: boolean; blockers: Blocker[] }
  | { s: "done" };

const field =
  "w-full min-w-0 rounded-[13px] border border-line bg-panel px-[18px] py-[15px] text-[16px] text-ink outline-none placeholder:text-faint focus:border-line-hover md:text-[14px]";

/** Phone → SMS code → what will happen (or what must finish first) → delete. */
export function DeleteAccountForm() {
  const [step, setStep] = useState<Step>({ s: "phone" });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const unavailable = "Something went wrong on our side. Please try again in a few minutes.";

  if (step.s === "done") {
    return (
      <div className="rounded-[14px] border border-brand-cyan bg-panel px-6 py-5 text-[14.5px] text-ink">
        <b>Your account has been deleted.</b>
        <p className="mt-1 text-muted">
          You&apos;ve been signed out everywhere. Records of completed deals and payments are
          kept without your name, as the law requires. You can sign up again with the same
          number at any time — it will be a new, empty account.
        </p>
      </div>
    );
  }

  if (step.s === "review") {
    if (!step.canDelete) {
      return (
        <div className="rounded-[14px] border border-line bg-panel px-6 py-5 text-[14.5px]">
          <b className="text-ink">These need to finish first</b>
          <p className="mt-1 text-muted">
            Money is still moving on your account, so it can&apos;t be deleted yet. Complete or
            cancel these in the WCP Markets app, then come back:
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-ink-secondary">
            {step.blockers.map((b) => (
              <li key={b.id}>
                {b.kind === "deal" ? "Open deal: " : "Pending payout: "}
                {b.label}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    return (
      <div className="rounded-[14px] border border-line bg-panel px-6 py-5 text-[14.5px]">
        <b className="text-ink">Delete your WCP Markets account?</b>
        <p className="mt-1 text-muted">This can&apos;t be undone.</p>
        {error && <p className="mt-3 text-[#FF8886]">{error}</p>}
        <GradientButton
          type="button"
          size="lg"
          className="mt-4 w-full sm:w-auto"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await confirmDeletion(step.token);
              if (r.ok) setStep({ s: "done" });
              else if (r.error === "blocked") setStep({ ...step, canDelete: false, blockers: r.blockers });
              else if (r.error === "expired") {
                setStep({ s: "phone" });
                setError("That took a while — please verify your number again.");
              } else setError(unavailable);
            })
          }
        >
          {pending ? "Deleting…" : "Delete my account permanently"}
        </GradientButton>
      </div>
    );
  }

  if (step.s === "code") {
    return (
      <form
        className="flex max-w-[480px] flex-col gap-2.5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            setError(null);
            const r = await verifyDeletionCode(step.phone, code);
            if (r.ok) setStep({ s: "review", token: r.token, canDelete: r.canDelete, blockers: r.blockers });
            else setError(r.error === "bad_code" ? "That code didn't work. Check it, or go back and send a new one." : unavailable);
          });
        }}
      >
        <p className="text-[14.5px] text-muted">
          If an account uses {step.phone}, we&apos;ve sent it a 6-digit code by SMS.
        </p>
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="6-digit code"
          aria-label="SMS code"
          className={field}
        />
        {error && <p className="text-[14px] text-[#FF8886]">{error}</p>}
        <div className="flex gap-2.5">
          <GradientButton type="submit" size="lg" disabled={pending}>
            {pending ? "Checking…" : "Continue"}
          </GradientButton>
          <button
            type="button"
            className="rounded-[13px] border border-line px-5 text-[14px] text-muted"
            onClick={() => {
              setCode("");
              setError(null);
              setStep({ s: "phone" });
            }}
          >
            Back
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      className="flex max-w-[480px] flex-col gap-2.5 sm:flex-row"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await sendDeletionCode(phone);
          if (r.ok) setStep({ s: "code", phone: r.phone });
          else setError(r.error === "invalid_phone" ? "Enter the Nigerian phone number on your account." : unavailable);
        });
      }}
    >
      <input
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="0803 123 4567"
        aria-label="Phone number"
        aria-invalid={error ? true : undefined}
        className={cn(field, "flex-1")}
      />
      <GradientButton type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
        {pending ? "Sending…" : "Send code"}
      </GradientButton>
      {error && <p className="text-[14px] text-[#FF8886] sm:hidden">{error}</p>}
      {error && <p className="hidden text-[14px] text-[#FF8886] sm:block sm:basis-full">{error}</p>}
    </form>
  );
}
