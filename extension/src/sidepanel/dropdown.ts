/**
 * Custom dropdown — a drop-in replacement for a native <select>.
 *
 * WHY THIS EXISTS
 * Chrome's side panel renders extension UI in a context where the native
 * <select> option picker can fail to open (the control focuses and receives
 * clicks, but the option popup never appears). This is a Chrome-side layout
 * bug that varies by version — the picker works on some channels (e.g. Beta)
 * and not others (e.g. Stable). See crbug 534387029 / 532450511.
 *
 * Rather than depend on the flaky native popup, we render the option list
 * ourselves inside the panel document, so it behaves identically on every
 * Chrome version.
 *
 * The component mirrors just enough of the <select> surface that the rest of
 * the panel keeps working with minimal changes:
 *   - a `value` getter/setter
 *   - a `selectedText` getter (native code used `selectedOptions[0].text`)
 *   - a "change" CustomEvent dispatched when the user picks a new value
 */

export interface DropdownOption {
  value: string;
  label: string;
}

export class Dropdown {
  /** The outer element you insert into the DOM. */
  readonly el: HTMLDivElement;

  private readonly trigger: HTMLButtonElement;
  private readonly list: HTMLDivElement;
  private readonly labelSpan: HTMLSpanElement;
  private readonly options: DropdownOption[];
  private currentValue: string;
  private open = false;

  constructor(options: DropdownOption[], initialValue?: string) {
    if (options.length === 0) throw new Error("Dropdown requires at least one option.");
    this.options = options;
    this.currentValue = initialValue ?? options[0].value;

    this.el = document.createElement("div");
    this.el.className = "dropdown";

    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "dropdown-trigger";
    this.trigger.setAttribute("aria-haspopup", "listbox");
    this.trigger.setAttribute("aria-expanded", "false");

    this.labelSpan = document.createElement("span");
    this.labelSpan.className = "dropdown-label";
    this.trigger.appendChild(this.labelSpan);

    const caret = document.createElement("span");
    caret.className = "dropdown-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "▾";
    this.trigger.appendChild(caret);

    this.list = document.createElement("div");
    this.list.className = "dropdown-list hidden";
    this.list.setAttribute("role", "listbox");

    for (const opt of this.options) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "dropdown-option";
      item.setAttribute("role", "option");
      item.dataset.value = opt.value;
      item.textContent = opt.label;
      item.addEventListener("click", () => {
        this.select(opt.value, true);
        this.close();
      });
      this.list.appendChild(item);
    }

    this.el.appendChild(this.trigger);
    this.el.appendChild(this.list);

    this.trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle();
    });

    // Close when clicking anywhere else, or on Escape.
    document.addEventListener("click", (e) => {
      if (this.open && !this.el.contains(e.target as Node)) this.close();
    });
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.open) {
        this.close();
        this.trigger.focus();
      }
    });

    this.render();
  }

  /** Current selected value (like select.value). */
  get value(): string {
    return this.currentValue;
  }

  set value(v: string) {
    this.select(v, false);
  }

  /** Label of the current option (replaces select.selectedOptions[0].text). */
  get selectedText(): string {
    return this.options.find((o) => o.value === this.currentValue)?.label ?? "";
  }

  private select(value: string, fireChange: boolean): void {
    if (!this.options.some((o) => o.value === value)) return;
    const changed = value !== this.currentValue;
    this.currentValue = value;
    this.render();
    if (fireChange && changed) {
      this.el.dispatchEvent(new CustomEvent("change", { detail: { value } }));
    }
  }

  private toggle(): void {
    this.open ? this.close() : this.openList();
  }

  private openList(): void {
    this.open = true;
    this.list.classList.remove("hidden");
    this.trigger.setAttribute("aria-expanded", "true");
  }

  private close(): void {
    this.open = false;
    this.list.classList.add("hidden");
    this.trigger.setAttribute("aria-expanded", "false");
  }

  private render(): void {
    this.labelSpan.textContent = this.selectedText;
    for (const child of Array.from(this.list.children)) {
      const item = child as HTMLElement;
      item.classList.toggle("selected", item.dataset.value === this.currentValue);
      item.setAttribute("aria-selected", String(item.dataset.value === this.currentValue));
    }
  }
}
