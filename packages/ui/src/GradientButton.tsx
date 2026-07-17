import type { ButtonHTMLAttributes, AnchorHTMLAttributes } from "react";
import { cn } from "./cn";

/** Shared look for the signature purple→cyan CTA: gradient bg, dark ink, pill/rounded. */
const base =
  "wcp-gradient wcp-gradient-hover inline-flex items-center justify-center " +
  "font-bold text-canvas transition-[filter] cursor-pointer select-none";

const sizes = {
  /** nav pill CTA */
  pill: "text-[13px] px-5 py-2.5 rounded-[999px]",
  /** hero / waitlist submit button */
  lg: "text-[14px] px-[26px] py-[15px] rounded-[13px]",
} as const;

type Size = keyof typeof sizes;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: Size;
  href?: undefined;
};
type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  size?: Size;
  href: string;
};

/**
 * The brand CTA. Renders an anchor when `href` is set, otherwise a button.
 * `size="pill"` for the nav CTA, `size="lg"` for form submit buttons.
 */
export function GradientButton(props: ButtonProps | LinkProps) {
  const { size = "lg", className, ...rest } = props;
  const cls = cn(base, sizes[size], className);

  if ("href" in props && props.href !== undefined) {
    const { href, ...anchorRest } = rest as LinkProps;
    return (
      <a href={href} className={cls} {...anchorRest}>
        {props.children}
      </a>
    );
  }
  return (
    <button className={cls} {...(rest as ButtonProps)}>
      {props.children}
    </button>
  );
}
