"use client";

import { useActionState, useState } from "react";
import { decideRecovery, resolveDispute, resolveReport, type ActionState } from "../actions";

const Result = ({ s }: { s: ActionState }) =>
  s.error ? (
    <p role="alert" className="text-sm text-[#e5645a]">{s.error}</p>
  ) : s.ok ? (
    <p role="status" className="text-sm text-lime">{s.message}</p>
  ) : null;

const btn = "rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50";

/** Release or refund. Both need a written reason and a deliberate confirm — money moves. */
export function DisputeDecision({ dealId, depositClaim }: { dealId: string; depositClaim: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(resolveDispute, {});
  const [choice, setChoice] = useState<"release" | "refund" | null>(null);
  if (state.ok) return <Result s={state} />;
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="resolution" value={choice ?? ""} />
      <label className="flex flex-col gap-1.5 text-sm">
        Reason for the decision (both parties may be told this)
        <textarea
          name="note"
          rows={3}
          required
          minLength={10}
          maxLength={2000}
          className="rounded-lg border border-line bg-canvas px-3 py-2 outline-none focus:border-brand-cyan"
        />
      </label>
      {choice == null ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setChoice("release")} className={`${btn} border border-line`}>
            {depositClaim ? "Pay the claim to the host…" : "Release to seller…"}
          </button>
          <button type="button" onClick={() => setChoice("refund")} className={`${btn} border border-line`}>
            {depositClaim ? "Return the deposit to the guest…" : "Refund buyer…"}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#e5645a]/40 bg-[#e5645a]/10 p-3">
          <span className="text-sm">
            {choice === "release"
              ? depositClaim ? "Pay the deposit claim to the host?" : "Release the money to the seller?"
              : depositClaim ? "Return the deposit to the guest?" : "Refund the buyer?"}{" "}
            This can&apos;t be undone.
          </span>
          <button disabled={pending} className={`${btn} bg-ink text-canvas`}>{pending ? "Working…" : "Confirm"}</button>
          <button type="button" disabled={pending} onClick={() => setChoice(null)} className={`${btn} text-muted`}>Cancel</button>
        </div>
      )}
      <Result s={state} />
    </form>
  );
}

export function ReportDecision({ reportId, canRemoveListing }: { reportId: string; canRemoveListing: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(resolveReport, {});
  if (state.ok) return <Result s={state} />;
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="reportId" value={reportId} />
      <input
        name="note"
        maxLength={500}
        placeholder="Note (optional)"
        className="rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-brand-cyan"
      />
      <div className="flex flex-wrap gap-2">
        <button name="action" value="dismiss" disabled={pending} className={`${btn} border border-line`}>Dismiss</button>
        <button name="action" value="uphold" disabled={pending} className={`${btn} border border-line`}>Uphold</button>
        {canRemoveListing && (
          <button name="action" value="remove_listing" disabled={pending} className={`${btn} border border-[#e5645a]/50 text-[#e5645a]`}>
            Remove listing
          </button>
        )}
      </div>
      <Result s={state} />
    </form>
  );
}

export function RecoveryDecision({ recoveryId }: { recoveryId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(decideRecovery, {});
  const [confirm, setConfirm] = useState(false);
  if (state.ok) return <Result s={state} />;
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="recoveryId" value={recoveryId} />
      {confirm ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#e5645a]/40 bg-[#e5645a]/10 p-3">
          <span className="text-sm">Move this account to the new number after a 24-hour hold?</span>
          <button name="decision" value="approve" disabled={pending} className={`${btn} bg-ink text-canvas`}>Approve</button>
          <button type="button" onClick={() => setConfirm(false)} className={`${btn} text-muted`}>Cancel</button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setConfirm(true)} className={`${btn} border border-line`}>Approve…</button>
          <button name="decision" value="reject" disabled={pending} className={`${btn} border border-line`}>Reject</button>
        </div>
      )}
      <Result s={state} />
    </form>
  );
}
