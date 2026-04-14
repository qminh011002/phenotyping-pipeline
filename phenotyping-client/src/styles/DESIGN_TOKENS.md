# Design Tokens Reference

This document is the **single source of truth** for all low-level design tokens used in the
phenotyping desktop application. All tokens are declared in `src/index.css` and resolved via
Tailwind CSS v4 `@theme`. Every component, page, and feature must reference these tokens — never
hardcode colors, border radii, or z-index values.

---

## 1. Radius Scale

| Token | Value | Tailwind | When to use |
|-------|-------|----------|-------------|
| `--radius` | `0.5rem` (8px) | base | Reference only — do not apply directly |
| `--radius-sm` | `calc(0.5rem - 4px)` = 4px | `rounded-sm` | Badges, small chips |
| `--radius-md` | `calc(0.5rem - 2px)` = 6px | `rounded-md` | **Buttons**, inputs, selects, textareas |
| `--radius-lg` | `0.5rem` = 8px | `rounded-lg` | Dialogs, popovers, dropdown menus |
| `--radius-xl` | `calc(0.5rem + 4px)` = 12px | `rounded-xl` | **Cards**, sheets on mobile |
| `--radius-full` | `9999px` | `rounded-full` | Pills, avatars, status dots |

### Radius Rules

- **Cards**: always `rounded-xl` (shadcn New York default).
- **Buttons**: `rounded-md` (all sizes including icon-only).
- **Dialogs**: `rounded-lg`.
- **Sheets**: **no radius** — flush with viewport edge.
- **Inputs, Selects, Textareas**: `rounded-md`.
- **Badges**: `rounded-md` (not pills).
- **Avatars, status dots**: `rounded-full`.
- **Tooltips, DropdownMenus**: `rounded-md`.

### Radius Anti-Patterns

```tsx
// ❌ BAD — literal pixel radius
className="rounded-[6px]"

// ✅ GOOD — use the Tailwind scale
className="rounded-md"
```

---

## 2. Border Width Scale

| Token | Value | Tailwind | When to use |
|-------|-------|----------|-------------|
| hairline (default) | 1px | `border` | Standard borders on cards, inputs, tables |
| emphasis | 1px + color change | `border-primary` | Selected card, drag-over drop zone — change **color**, never width |
| focus ring | 3px | `focus-visible:ring-[3px] focus-visible:ring-ring/50` | Keyboard focus on all interactive elements |

### Border Rules

- Standard border: `border` utility (1px hairline, `--border` color).
- Never increase border width beyond 1px for emphasis — use `border-primary` or `border-destructive` instead.
- Divider/separator: `bg-border` on a thin `<div>` or `<Separator />`.
- All shadcn components use `focus-visible:ring-[3px] focus-visible:ring-ring/50` for the New York focus style.

---

## 3. Elevation / Shadow Ramp

| Token | Value | Tailwind | When to use |
|-------|-------|----------|-------------|
| `--shadow-xs` | `0 1px 2px 0 rgb(0 0 0 / 0.05)` | `shadow-xs` | Outline buttons (`variant="outline"`) |
| `--shadow-sm` | `0 1px 3px 0 ...` | `shadow-sm` | Cards at rest |
| `--shadow-md` | `0 4px 6px -1px ...` | `shadow-md` | Cards on hover, elevated state |
| `--shadow-lg` | `0 10px 15px -3px ...` | `shadow-lg` | **Dialogs**, popovers, dropdown menus, sheets, toasts |
| `--shadow-xl` | `0 20px 25px -5px ...` | `shadow-xl` | Reserved for modals / heavy overlays — do not use casually |

### Shadow Rules

- Outline button: `shadow-xs` (already encoded in `button.tsx`).
- Card at rest: `shadow-sm`.
- Card hover: `shadow-md`.
- Dialog, Popover, DropdownMenu, Sheet: `shadow-lg`.
- Toast (Sonner): `shadow-lg`.
- Never use `shadow-2xl` — too heavy for a desktop app.

---

## 4. Semantic Color Tokens

Declared in `:root` (light mode) and `.dark` (dark mode). All map to `--color-*` in `@theme`.

| Token | Light | Dark | When to use |
|-------|-------|------|-------------|
| `--background` | `#fafafa` | `#222` | Page background |
| `--foreground` | `#18181b` | `#f7f7f7` | Primary text |
| `--card` | `#ffffff` | `#2a2a2a` | Card surfaces |
| `--card-foreground` | `#18181b` | `#f7f7f7` | Card text |
| `--primary` | `#27272a` | `#ebebeb` | Primary actions (buttons) |
| `--primary-foreground` | `#fafafa` | `#18181b` | Text on primary |
| `--secondary` | `#f4f4f5` | `#3f3f46` | Secondary surfaces |
| `--secondary-foreground` | `#27272a` | `#f7f7f7` | Text on secondary |
| `--muted` | `#f4f4f5` | `#3f3f46` | Subtle backgrounds |
| `--muted-foreground` | `#71717a` | `#a1a1aa` | Helper text, timestamps |
| `--accent` | `#f4f4f5` | `#3f3f46` | Hover/active highlight |
| `--accent-foreground` | `#27272a` | `#f7f7f7` | Text on accent |
| `--destructive` | `#dc2626` | `#a33232` | Danger/delete actions |
| `--destructive-foreground` | `#fafafa` | `#f7f7f7` | Text on destructive |
| `--border` | `#e4e4e7` | `#3f3f46` | All borders |
| `--input` | `#e4e4e7` | `#3f3f46` | Input backgrounds |
| `--ring` | `#71717a` | `#71717a` | Focus ring color |

### Color Rules

- All text uses `--foreground` (primary) or `--muted-foreground` (secondary).
- Backgrounds: `--background` for page, `--card` for elevated surfaces.
- Actions: `--primary` for default, `--destructive` for delete.
- Muted/secondary: `--muted`, `--secondary` for subtle backgrounds.
- **Never hardcode hex, rgb(), or hsl() values** in components — use the semantic tokens.

```tsx
// ❌ BAD
className="bg-zinc-100 text-zinc-800"

// ✅ GOOD
className="bg-muted text-muted-foreground"
```

---

## 5. Typography

### Font Families

| Token | Value | Usage |
|-------|-------|-------|
| `--font-sans` | `"InterVariable", ui-sans-serif, system-ui, sans-serif` | Default — all body text |
| `--font-mono` | `"JetBrains MonoVariable", ui-monospace, monospace` | Numeric values, egg counts, confidence scores |

### Font Scale

Tailwind maps to the standard scale. Explicit sizes with line-heights:

| Class | Size | Line-height | When to use |
|-------|------|-------------|-------------|
| `text-xs` | 0.75rem | 1rem | Timestamps, helper text |
| `text-sm` | 0.875rem | 1.25rem | Body default, labels, descriptions |
| `text-base` | 1rem | 1.5rem | Emphasized body |
| `text-lg` | 1.125rem | 1.75rem | Page titles |
| `text-xl` | 1.25rem | 1.75rem | Section headers |
| `text-2xl` | 1.5rem | 2rem | Metric numbers (medium) |
| `text-3xl` | 1.875rem | 2.25rem | Hero metrics (egg count) |

### Typography Rules

- Page titles: `text-lg font-semibold`.
- Numeric values (egg count, confidence, time): **always** `font-mono tabular-nums` for column alignment.
- Muted text: `text-muted-foreground` — never `opacity-*`.
- Section headers: `text-xl font-semibold`.

```tsx
// ✅ GOOD — numeric values always use font-mono tabular-nums
<span className="font-mono tabular-nums">{count.toLocaleString()}</span>
```

---

## 6. Z-Index Scale

Prevents z-index conflicts with Radix UI portals (popover, dropdown, sheet, dialog).

| Token | Value | Tailwind | What uses it |
|-------|-------|----------|-------------|
| `--z-base` | `0` | `z-0` | Default stacking |
| `--z-sticky` | `20` | `z-20` | Sticky page headers |
| `--z-dropdown` | `40` | `z-40` | Dropdown menus |
| `--z-overlay` | `50` | `z-50` | Dialog/sheet overlay backdrop |
| `--z-modal` | `60` | `z-60` | Dialog/sheet content |
| `--z-popover` | `70` | `z-70` | Popovers |
| `--z-toast` | `80` | `z-80` | Sonner toasts |
| `--z-tooltip` | `90` | `z-90` | Tooltips |

**Radix UI components already use these values internally. Do not override z-index on shadcn primitives.**

---

## 7. Animation Tokens

### Duration

| Class | Value | When to use |
|-------|-------|-------------|
| `duration-200` | 200ms | Micro-interactions (hover, focus) |
| `duration-300` | 300ms | Page transitions, dialog open |

### Fade

| Class | When to use |
|-------|-------------|
| `animate-fade-in` | Page content appearing |
| `animate-fade-out` | Page content leaving |

### Utility Classes Available

All defined as `@utility` in `index.css`:

```
animate-in           — animation-fill-mode: both; animation-duration: 200ms
animate-out          — animation-fill-mode: both; animation-duration: 200ms
fade-in-0           — animation-name: fadeIn (use with animate-in)
fade-out-0          — animation-name: fadeOut (use with animate-out)
zoom-in-95          — animation-name: zoomIn (use with animate-in)
zoom-out-95         — animation-name: zoomOut (use with animate-out)
slide-in-from-right — Sheet/overlay slide in from right
slide-out-to-right  — Sheet/overlay slide out to right
```

---

## 8. Usage Matrix

| Component | Radius | Shadow | Border | Focus ring |
|-----------|--------|--------|--------|------------|
| Card | `rounded-xl` | `shadow-sm` at rest | `border` | N/A |
| Card hover | `rounded-xl` | `shadow-md` | `border` | N/A |
| Button default | `rounded-md` | — | — | `ring-[3px] ring/50` |
| Button outline | `rounded-md` | `shadow-xs` | `border` | `ring-[3px] ring/50` |
| Input | `rounded-md` | — | `border` | `ring-[3px] ring/50` |
| Dialog | `rounded-lg` | `shadow-lg` | `border` | N/A |
| Sheet | **none** | `shadow-lg` | `border-l` (right) | N/A |
| Popover | `rounded-lg` | `shadow-lg` | `border` | N/A |
| Toast | `rounded-lg` | `shadow-lg` | `border` | N/A |
| Badge | `rounded-md` | — | — | N/A |
| Tooltip | `rounded-md` | `shadow-md` | — | N/A |
| DropdownMenu | `rounded-md` | `shadow-lg` | `border` | N/A |
| AlertDialog | `rounded-lg` | `shadow-lg` | `border` | N/A |
| Separator | N/A | — | `bg-border` | N/A |

---

## 9. Do / Don't

### Do

```tsx
// Colors via semantic tokens
className="bg-card text-muted-foreground border-border"

// Radius via Tailwind scale
className="rounded-xl"

// Shadow via semantic tokens
className="shadow-sm hover:shadow-md"

// Font via semantic tokens
className="font-mono tabular-nums"

// Focus ring via the pattern
className="focus-visible:ring-[3px] focus-visible:ring-ring/50"
```

### Don't

```tsx
// ❌ Hardcoded colors
className="bg-zinc-100 text-zinc-800"

// ❌ Hardcoded pixel radius
className="rounded-[6px]"

// ❌ Raw RGB values
style={{ color: "rgb(24, 24, 27)" }}

// ❌ Inline hex
style={{ backgroundColor: "#e4e4e7" }}

// ❌ Numeric z-index without token
className="z-50"

// ❌ Width increase for emphasis
className="border-2 border-primary" // ❌ width change
className="border border-primary"    // ✅ color change
```
