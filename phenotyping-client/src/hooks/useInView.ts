// useInView — true once the element has come within `rootMargin` of the
// viewport. One shared IntersectionObserver per margin serves every caller,
// so a 200-card grid doesn't create 200 observers.

import { useEffect, useRef, useState } from 'react';

const observers = new Map<string, IntersectionObserver>();
const callbacks = new WeakMap<Element, () => void>();

function observerFor(rootMargin: string): IntersectionObserver {
    let observer = observers.get(rootMargin);
    if (!observer) {
        observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const cb = callbacks.get(entry.target);
                    callbacks.delete(entry.target);
                    observer!.unobserve(entry.target);
                    cb?.();
                }
            },
            { rootMargin },
        );
        observers.set(rootMargin, observer);
    }
    return observer;
}

/** Latches to true the first time the element is near the viewport. */
export function useInView<T extends Element>(
    rootMargin = '300px',
): [React.RefObject<T | null>, boolean] {
    const ref = useRef<T | null>(null);
    const [seen, setSeen] = useState(false);

    useEffect(() => {
        if (seen) return;
        const el = ref.current;
        if (!el) return;
        if (typeof IntersectionObserver === 'undefined') {
            setSeen(true);
            return;
        }
        const observer = observerFor(rootMargin);
        callbacks.set(el, () => setSeen(true));
        observer.observe(el);
        return () => {
            callbacks.delete(el);
            observer.unobserve(el);
        };
    }, [seen, rootMargin]);

    return [ref, seen];
}
