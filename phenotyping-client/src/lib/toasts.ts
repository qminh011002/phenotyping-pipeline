/**
 * Toast helpers.
 *
 * `toastAction` is the one way a user-triggered API call reports itself: a
 * loading toast while the request runs, then the same toast turns into a
 * success or error message saying what happened. Background work (autosave,
 * page loads) stays quiet on success and only toasts its errors.
 */
import type { ReactNode } from 'react';
import { toast } from '@/components/ui/sonner';

export interface ToastText {
    title: string;
    description?: ReactNode;
    /** A finished task that still needs attention reports as a warning. */
    tone?: 'success' | 'warning' | 'info';
}

type Message<A> = string | ToastText | ((arg: A) => string | ToastText);

function resolve<A>(message: Message<A>, arg: A): ToastText {
    const value = typeof message === 'function' ? message(arg) : message;
    return typeof value === 'string' ? { title: value } : value;
}

/** Human-readable reason from anything a request can throw. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return fallback;
}

/**
 * Run `task` behind a loading toast, then report how it went on that same
 * toast. The task's result is returned and its error re-thrown, so callers
 * keep their own state handling — they just must not toast again.
 *
 * A failure toast uses `error` as its title and the thrown message as its
 * description, unless `error` is a function that builds both.
 */
export async function toastAction<T>(
    task: Promise<T> | (() => Promise<T>),
    messages: {
        loading: string;
        success: Message<T>;
        error: Message<unknown>;
    },
): Promise<T> {
    const id = toast.loading(messages.loading);
    try {
        const result = await (typeof task === 'function' ? task() : task);
        const { title, description, tone = 'success' } = resolve(messages.success, result);
        toast[tone](title, { id, description });
        return result;
    } catch (err) {
        const text = resolve(messages.error, err);
        toast.error(text.title, {
            id,
            description: text.description ?? errorMessage(err),
        });
        throw err;
    }
}
