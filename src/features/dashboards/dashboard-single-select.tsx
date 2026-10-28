import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

export interface DashboardSingleSelectOption {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

interface DashboardSingleSelectProps {
  id: string;
  labelledBy: string;
  value: string;
  options: readonly DashboardSingleSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  noOptionsLabel?: string;
}

function filterGroup(element: HTMLElement | null): Element | null {
  return element?.closest("[data-filter-group]")
    ?? element?.closest(".filter-grid")
    ?? element?.closest(".filters-card")
    ?? element?.closest(".feishu-share-dialog")
    ?? element?.parentElement
    ?? null;
}

function scrollForMenu(anchor: HTMLElement, requestedHeight: number): void {
  const below = window.innerHeight - anchor.getBoundingClientRect().bottom - 10;
  const availableViewport = Math.max(80, window.innerHeight - 32);
  const needed = Math.min(requestedHeight, availableViewport);
  if (below >= needed) return;
  const delta = needed - below;

  let parent = anchor.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const style = window.getComputedStyle(parent);
    const scrollable = /(auto|scroll|overlay)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1;
    if (scrollable) {
      const remaining = parent.scrollHeight - parent.clientHeight - parent.scrollTop;
      const amount = Math.min(delta, Math.max(0, remaining));
      if (amount > 0) { parent.scrollTop += amount; return; }
    }
    parent = parent.parentElement;
  }

  const documentRemaining = Math.max(0, document.documentElement.scrollHeight - window.innerHeight - window.scrollY);
  if (documentRemaining > 0) window.scrollBy(0, Math.min(delta, documentRemaining));
}

export function DashboardSingleSelect({
  id,
  labelledBy,
  value,
  options,
  onChange,
  disabled = false,
  placeholder,
  noOptionsLabel = "Nenhuma opção disponível.",
}: DashboardSingleSelectProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>();
  const selected = options.find((option) => option.value === value);
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
  const focusOptionIndex = selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled);
  const groups = options.reduce<Array<{ label: string | null; options: DashboardSingleSelectOption[] }>>((result, option) => {
    const label = option.group ?? null;
    let group = result.at(-1);
    if (!group || group.label !== label) {
      group = { label, options: [] };
      result.push(group);
    }
    group.options.push(option);
    return result;
  }, []);

  const updatePosition = useCallback(() => {
    const anchor = triggerRef.current;
    if (!anchor || !detailsRef.current?.open) return;
    const bounds = anchor.getBoundingClientRect();
    const width = Math.max(120, Math.min(bounds.width, window.innerWidth - 16));
    const left = Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8));
    const maxHeight = Math.max(0, Math.min(320, window.innerHeight - bounds.bottom - 10));
    setPosition({ left, top: bounds.bottom + 6, width, maxHeight });
  }, []);

  useEffect(() => {
    const closeOtherSelects = (event: Event) => {
      const detail = (event as CustomEvent<{ group: Element | null; element: HTMLElement }>).detail;
      const current = detailsRef.current;
      if (current?.open && detail?.group === filterGroup(current) && detail.element !== current) current.open = false;
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (detailsRef.current?.open && !detailsRef.current.contains(target) && !popoverRef.current?.contains(target)) {
        detailsRef.current.open = false;
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && detailsRef.current?.open) {
        event.preventDefault();
        detailsRef.current.open = false;
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("dashboard-multiselect-open", closeOtherSelects);
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("dashboard-multiselect-open", closeOtherSelects);
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const schedulePosition = () => window.requestAnimationFrame(updatePosition);
    const frame = window.requestAnimationFrame(() => {
      if (triggerRef.current) scrollForMenu(triggerRef.current, 260);
      updatePosition();
      if (focusOptionIndex >= 0) optionRefs.current[focusOptionIndex]?.focus({ preventScroll: true });
    });
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedulePosition);
      window.removeEventListener("scroll", schedulePosition, true);
    };
  }, [focusOptionIndex, open, updatePosition]);

  const close = (restoreFocus = false) => {
    if (detailsRef.current) detailsRef.current.open = false;
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const choose = (option: DashboardSingleSelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    close(true);
  };

  const moveFocus = (index: number, direction: -1 | 1, edge?: "first" | "last") => {
    const enabled = options.map((option, optionIndex) => option.disabled ? -1 : optionIndex).filter((optionIndex) => optionIndex >= 0);
    if (!enabled.length) return;
    const next = edge === "first" ? enabled[0] : edge === "last" ? enabled.at(-1)! : enabled[(enabled.indexOf(index) + direction + enabled.length) % enabled.length];
    optionRefs.current[next]?.focus();
  };

  return <>
    <details
      ref={detailsRef}
      className="multi-select dashboard-single-select"
      aria-disabled={disabled || undefined}
      onToggle={(event) => {
        const current = event.currentTarget;
        setOpen(current.open);
        if (!current.open) return;
        document.dispatchEvent(new CustomEvent("dashboard-multiselect-open", {
          detail: { group: filterGroup(current), element: current },
        }));
      }}
    >
      <summary
        id={id}
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={labelledBy}
        aria-disabled={disabled || undefined}
        onClick={disabled ? (event) => event.preventDefault() : undefined}
        onKeyDown={(event) => {
          if (disabled || open || !(event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ")) return;
          event.preventDefault();
          detailsRef.current!.open = true;
        }}
      >
        <span>{selected?.label ?? placeholder ?? "Selecione"}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
    </details>
    {open && typeof document !== "undefined" ? createPortal(
      <div
        ref={popoverRef}
        id={listId}
        className="multi-select-popover dashboard-single-select-popover"
        role="listbox"
        aria-labelledby={labelledBy}
        style={position}
      >
        {groups.map((group, groupIndex) => <div role="group" aria-label={group.label ?? "Opções"} key={`${group.label ?? "ungrouped"}-${groupIndex}`}>
          {group.label ? <div className="dashboard-single-select-group-label">{group.label}</div> : null}
          {group.options.map((option) => {
            const index = options.indexOf(option);
            return <button
              ref={(element) => { optionRefs.current[index] = element; }}
              type="button"
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              disabled={option.disabled}
              tabIndex={-1}
              className={`menu-option${option.value === value ? " selected" : ""}`}
              data-option-index={index}
              key={`${option.value}-${index}`}
              onClick={() => choose(option)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault(); moveFocus(index, event.key === "ArrowDown" ? 1 : -1);
                } else if (event.key === "Home" || event.key === "End") {
                  event.preventDefault(); moveFocus(index, 1, event.key === "Home" ? "first" : "last");
                } else if (event.key === "Escape") {
                  event.preventDefault(); close(true);
                } else if (event.key === "Tab") {
                  const trigger = triggerRef.current;
                  if (!trigger) return;
                  const focusable = Array.from(document.querySelectorAll<HTMLElement>(
                    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
                  )).filter((element) => !popoverRef.current?.contains(element) && element.getAttribute("aria-disabled") !== "true" && element.getClientRects().length > 0);
                  const triggerIndex = focusable.indexOf(trigger);
                  const next = focusable[triggerIndex + (event.shiftKey ? -1 : 1)];
                  if (next) {
                    event.preventDefault();
                    close(false);
                    next.focus();
                  } else {
                    close(false);
                  }
                }
              }}
            ><span title={option.label}>{option.label}</span></button>;
          })}
        </div>)}
        {options.length === 0 ? <p className="menu-empty">{noOptionsLabel}</p> : null}
      </div>,
      document.body,
    ) : null}
  </>;
}
