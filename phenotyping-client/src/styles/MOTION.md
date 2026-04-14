# Motion System — Authoritative Reference

This file documents every motion token, primitive, and rule used in the app. Every
animation must pull from this file — no custom durations or easings outside of
`src/lib/motion.ts` and `src/index.css`.

---

## Duration Tokens

| Token | Value | Use Case |
|-------|-------|----------|
| `DURATION.instant` | `0` | `prefers-reduced-motion` fallback |
| `DURATION.fast` | `150ms` | Hover, focus, tiny fades |
| `DURATION.base` | `200ms` | Default — most fades and small slides |
| `DURATION.medium` | `300ms` | Dialog, sheet, popover |
| `DURATION.slow` | `500ms` | Page transitions, first-load stagger |

**Rule:** if your animation needs a duration outside 150–500ms, stop and reconsider.

CSS equivalent: `--duration-fast`, `--duration-base`, `--duration-medium`, `--duration-slow`.

---

## Easing Tokens

| Token | Bezier | Use Case |
|-------|--------|----------|
| `EASE.out` | `cubic-bezier(0.32, 0.72, 0, 1)` | **Default for entrances.** iOS-style — decelerates hard at the end. |
| `EASE.in` | `cubic-bezier(0.64, 0, 0.78, 0)` | Exits only. |
| `EASE.inOut` | `cubic-bezier(0.65, 0, 0.35, 1)` | Symmetric open/close. |
| `EASE.standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | Material-ish standard curve. |

**Rule:** CSS for hover/focus/active; Framer Motion for entrance/exit/layout/stagger.
**Rule:** Never use `linear`.

CSS equivalent: `--ease-out`, `--ease-in`, `--ease-in-out`, `--ease-standard`.

---

## Shared Variants

| Variant | Initial | Animate | Exit |
|---------|---------|---------|------|
| `fadeVariants` | `opacity: 0` | `opacity: 1` | `opacity: 0` |
| `slideUpVariants` | `opacity: 0, y: 8` | `opacity: 1, y: 0` | `opacity: 0, y: 4` |
| `zoomVariants` | `opacity: 0, scale: 0.96` | `opacity: 1, scale: 1` | `opacity: 0, scale: 0.96` |
| `pageVariants` | `opacity: 0, y: 4` | `opacity: 1, y: 0` (300ms) | `opacity: 0, y: -4` (150ms) |
| `listContainerVariants` | `{}` | `staggerChildren: 0.04, delayChildren: 0.02` | — |
| `listItemVariants` | `opacity: 0, y: 6` | `opacity: 1, y: 0` | — |

**Rule:** never `translateY` more than 8px on entrance.

---

## Which Primitive for Which Scenario

| Scenario | Primitive | Variant |
|----------|-----------|---------|
| Page-level content on route change | `<MotionPage>` | `pageVariants` |
| List of cards/rows (first mount) | `<MotionList>` + `<MotionItem>` | `listContainerVariants` / `listItemVariants` |
| Single card entrance in a list | `<MotionItem>` | `listItemVariants` |
| Wrapper for route-level `<AnimatePresence>` | `<MotionPresence>` | — |
| One-shot fade entrance | `<FadeIn>` | `fadeVariants` |
| One-shot fade + slide entrance | `<SlideUp>` | `slideUpVariants` |
| One-shot fade + scale entrance | `<ZoomIn>` | `zoomVariants` |

All primitives accept an optional `delay?: number` prop.

---

## CSS-Only Interactions (No Framer)

These use Tailwind utilities with motion tokens — no Framer needed.

```tsx
// Card hover elevate
className="transition-shadow duration-200 ease-out hover:shadow-md"

// Button press feedback
className="active:scale-[0.98] transition-transform duration-100 ease-out"

// Link / ghost button hover
className="transition-colors duration-150 ease-out"

// Icon rotate on chevron toggle
className="transition-transform duration-200 ease-out data-[state=open]:rotate-180"
```

---

## Performance Rules

1. Only animate `opacity`, `transform`, and `filter`. Never animate `height`, `width`,
   `top`, `left`, `margin` — those trigger layout.
2. For collapsing content (accordion), use the existing Radix keyframes that animate
   `--radix-*-content-height` — already wired in `index.css`.
3. Every `motion.*` on a frequently-updated element (progress bar, log viewer) **must**
   have `layout={false}` unless a layout animation is genuinely needed.
4. Never animate inside a virtualized list without `layoutScroll`.
5. Wrap large lists (>50 items) in `MotionList` only during first mount — disable stagger
   on subsequent re-renders by keying on `initialMount`.

---

## Reduced Motion

- `<MotionConfig reducedMotion="user">` wraps the app in `AppProviders.tsx`.
- `useReducedMotionSafe()` hook returns `true` when OS has `prefers-reduced-motion: reduce`.
- CSS fallback: all CSS animations/transitions collapse to `0.01ms` via media query at the
  bottom of `index.css`.
- When `useReducedMotionSafe()` returns `true`, consumers should fall back to
  `fadeVariants` only (no translate/scale).

---

## Worked Examples

### Page Transition

```tsx
// In the page component (wired in FE-024 via router)
<MotionPresence>
  <Routes>
    <Route path="/home" element={
      <MotionPage><HomePage /></MotionPage>
    } />
  </Routes>
</MotionPresence>
```

### Card List Entrance

```tsx
<MotionList className="grid gap-4">
  {analyses.map(analysis => (
    <MotionItem key={analysis.id}>
      <AnalysisCard analysis={analysis} />
    </MotionItem>
  ))}
</MotionList>
```

### Dialog Open

```tsx
// The dialog itself uses Radix + the CSS keyframes in index.css.
// Wrap the content inside with ZoomIn for an extra entrance layer:
<DialogContent>
  <ZoomIn>
    <DialogHeader>
      <DialogTitle>Analysis Results</DialogTitle>
    </DialogHeader>
    {/* ... */}
  </ZoomIn>
</DialogContent>
```
