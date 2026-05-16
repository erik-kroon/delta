import { For, splitProps, type JSX, type ParentProps } from "solid-js";

type KbdSize = "sm" | "default" | "lg";
type KbdVariant = "default" | "muted" | "outline";

export type KbdProps = ParentProps<
  JSX.HTMLAttributes<HTMLElement> & {
    size?: KbdSize;
    variant?: KbdVariant;
  }
>;

export type KbdGroupProps = ParentProps<JSX.HTMLAttributes<HTMLSpanElement>>;

export type KbdShortcutProps = Omit<KbdGroupProps, "children"> & {
  keys: string[];
  size?: KbdSize;
  variant?: KbdVariant;
  separator?: string;
};

const classes = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(" ");

const kbdSizeClass: Record<KbdSize, string> = {
  sm: "h-[1.125rem] min-w-[1.125rem] px-1 text-[0.625rem]",
  default: "h-5 min-w-5 px-1.5 text-[0.6875rem]",
  lg: "h-6 min-w-6 px-2 text-xs",
};

const kbdVariantClass: Record<KbdVariant, string> = {
  default: "border-transparent bg-zinc-800/88 text-zinc-300",
  muted: "border-transparent bg-zinc-900/70 text-zinc-500",
  outline: "border-zinc-700/90 bg-transparent text-zinc-300",
};

export function Kbd(props: KbdProps) {
  const [local, rest] = splitProps(props, ["class", "size", "variant"]);
  const size = () => local.size ?? "default";
  const variant = () => local.variant ?? "default";

  return (
    <kbd
      {...rest}
      data-scope="ui-kbd"
      data-part="root"
      data-size={size()}
      data-slot="kbd"
      data-variant={variant()}
      class={classes(
        "ui-kbd pointer-events-none inline-flex select-none items-center justify-center rounded border font-sans font-medium leading-none shadow-[inset_0_-1px_rgba(0,0,0,0.32)]",
        kbdSizeClass[size()],
        kbdVariantClass[variant()],
        local.class,
      )}
    />
  );
}

export function KbdGroup(props: KbdGroupProps) {
  const [local, rest] = splitProps(props, ["class"]);

  return (
    <span
      {...rest}
      data-scope="ui-kbd"
      data-part="group"
      data-slot="kbd-group"
      class={classes("ui-kbd-group inline-flex items-center gap-1 whitespace-nowrap", local.class)}
    />
  );
}

export function KbdSeparator(props: ParentProps<JSX.HTMLAttributes<HTMLSpanElement>>) {
  const [local, rest] = splitProps(props, ["children", "class"]);

  return (
    <span
      {...rest}
      aria-hidden="true"
      data-scope="ui-kbd"
      data-part="separator"
      data-slot="kbd-separator"
      class={classes("ui-kbd-separator text-xs leading-none text-zinc-600", local.class)}
    >
      {local.children ?? "+"}
    </span>
  );
}

export function KbdShortcut(props: KbdShortcutProps) {
  const [local, rest] = splitProps(props, ["keys", "size", "variant", "separator", "class"]);

  return (
    <KbdGroup {...rest} class={local.class}>
      <For each={local.keys}>
        {(key, index) => (
          <>
            <Kbd size={local.size} variant={local.variant}>
              {key}
            </Kbd>
            {index() < local.keys.length - 1 ? (
              <KbdSeparator>{local.separator ?? "+"}</KbdSeparator>
            ) : null}
          </>
        )}
      </For>
    </KbdGroup>
  );
}
