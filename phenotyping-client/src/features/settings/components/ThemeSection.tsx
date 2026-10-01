// ThemeSection — appearance settings: choose the light or dark theme.
// Uses the useTheme() hook from the theme provider.

import { Moon, Sun } from 'lucide-react';

import { SegmentedControl, type SegmentedOption } from '@/components/common';
import { useTheme, type Theme } from '@/hooks/useTheme';
import { SettingsSection } from './SettingsSection';

const THEME_OPTIONS: SegmentedOption<Theme>[] = [
    {
        value: 'light',
        title: 'Switch to light theme',
        label: (
            <>
                <Sun className="size-3.5" aria-hidden />
                Light
            </>
        ),
    },
    {
        value: 'dark',
        title: 'Switch to dark theme',
        label: (
            <>
                <Moon className="size-3.5" aria-hidden />
                Dark
            </>
        ),
    },
];

export function ThemeSection() {
    const { theme, setTheme } = useTheme();
    const isDark = theme === 'dark';

    return (
        <SettingsSection
            title="Appearance"
            description="Customize how the app looks on your device."
        >
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <div className="min-w-0">
                    <p className="text-sm font-medium">Theme</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {isDark ? 'Dark mode' : 'Light mode'} is on. Your choice is saved on this
                        device.
                    </p>
                </div>
                <SegmentedControl
                    aria-label="Theme"
                    value={theme}
                    onChange={setTheme}
                    options={THEME_OPTIONS}
                />
            </div>
        </SettingsSection>
    );
}
