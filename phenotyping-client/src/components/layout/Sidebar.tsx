import { NavLink, useLocation } from 'react-router-dom';
import {
    Bell,
    ChevronsUpDown,
    CircleHelp,
    Cpu,
    CreditCard,
    FlaskConical,
    Folder,
    FolderOpen,
    Home,
    LogOut,
    Moon,
    Send,
    Settings,
    ShieldCheck,
    Sparkles,
    Sun,
} from 'lucide-react';

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Sidebar as SidebarRoot,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
    useSidebar,
} from '@/components/ui/sidebar';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { logout } from '@/services/auth';
import { useNavigate } from 'react-router-dom';
import { ProcessingIndicator } from './ProcessingIndicator';

const NAV_ITEMS = [
    { to: '/', icon: Home, label: 'Dashboard', end: true },
    { to: '/models', icon: Cpu, label: 'Models', end: false },
    { to: '/settings', icon: Settings, label: 'Settings', end: false },
] as const;

// The sidebar's call-to-action pair, cut like the app's keycap `Button`s.
// SidebarMenuButton keeps the collapsed-rail sizing and tooltips; these
// classes swap its flat hover fill for a raised key that presses down.
const KEYCAP_ACTION =
    'keycap h-9 gap-2 border font-medium transition-[color,background-color,border-color,box-shadow,transform,width,height,padding] focus-visible:ring-sidebar-ring';
const KEYCAP_PRIMARY = `${KEYCAP_ACTION} border-[var(--keycap-edge)] bg-primary text-primary-foreground [--keycap-edge:color-mix(in_oklab,var(--primary)_70%,black)] hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground data-[active=true]:bg-primary data-[active=true]:text-primary-foreground`;
const KEYCAP_OUTLINE = `${KEYCAP_ACTION} bg-key text-foreground [--keycap-edge:var(--key-edge)] hover:bg-key-hover hover:text-foreground active:bg-key-hover active:text-foreground dark:border-white/12 data-[active=true]:border-primary/40 data-[active=true]:bg-primary/10 data-[active=true]:text-primary data-[active=true]:[--keycap-edge:color-mix(in_oklab,var(--primary)_45%,var(--edge))]`;

const ICON_SWAP =
    'absolute inset-0 size-4 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none';

/** Closed folder that swings open while its page is showing. */
function FolderIcon({ open }: { open: boolean }) {
    return (
        <span aria-hidden className="relative size-4 shrink-0">
            <Folder
                className={cn(ICON_SWAP, open ? 'scale-75 -rotate-12 opacity-0' : 'opacity-100')}
            />
            <FolderOpen
                className={cn(ICON_SWAP, open ? 'opacity-100' : 'scale-75 rotate-12 opacity-0')}
            />
        </span>
    );
}

interface SidebarProps {
    collapsed?: boolean;
    onCollapsedChange?: (collapsed: boolean) => void;
}

export function Sidebar({ collapsed: collapsedProp }: SidebarProps) {
    const location = useLocation();
    const navigate = useNavigate();
    const { isMobile, state } = useSidebar();
    const { theme, toggleTheme } = useTheme();
    const collapsed = collapsedProp ?? state === 'collapsed';
    const ThemeIcon = theme === 'light' ? Moon : Sun;
    const user = useAuthStore((s) => s.user);
    const displayName = user?.name?.trim() || user?.email?.split('@')[0] || 'User';
    const initial = (user?.name?.trim()?.[0] || user?.email?.[0] || 'U').toUpperCase();
    const subtitle = user?.email ?? 'Workspace';
    const recordedActive = location.pathname.startsWith('/recorded');

    async function handleLogout() {
        await logout();
        navigate('/login', { replace: true });
    }

    return (
        <SidebarRoot collapsible="icon" variant="inset">
            <SidebarHeader>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton size="lg" asChild tooltip="Phenotyping">
                            <NavLink to="/">
                                <div className="flex aspect-square size-8 shrink-0 items-center justify-center overflow-hidden rounded-md">
                                    <img
                                        src="/assets/logo/app-icon.png"
                                        alt=""
                                        className="h-full w-full scale-105 object-cover"
                                        aria-hidden="true"
                                    />
                                </div>
                                <div className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                                    <span className="truncate font-semibold">Phenotyping</span>
                                    <span className="truncate text-xs text-sidebar-foreground/70">
                                        Analysis workspace
                                    </span>
                                </div>
                            </NavLink>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>

            <SidebarContent>
                <SidebarGroup className="pb-0">
                    <SidebarGroupContent>
                        <SidebarMenu className="gap-2">
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    asChild
                                    tooltip="Start analysis"
                                    className={KEYCAP_PRIMARY}
                                >
                                    <NavLink to="/analyze" className="px-3">
                                        <FlaskConical />
                                        <span>Start analysis</span>
                                    </NavLink>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    asChild
                                    isActive={recordedActive}
                                    tooltip="Recorded"
                                    className={KEYCAP_OUTLINE}
                                >
                                    <NavLink to="/recorded" className="px-3">
                                        <FolderIcon open={recordedActive} />
                                        <span>Recorded</span>
                                    </NavLink>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>

                <SidebarGroup>
                    <SidebarGroupLabel>Workspace</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {NAV_ITEMS.map((item) => {
                                const isActive = item.end
                                    ? location.pathname === item.to
                                    : location.pathname.startsWith(item.to);

                                return (
                                    <SidebarMenuItem key={item.to}>
                                        <SidebarMenuButton
                                            asChild
                                            isActive={isActive}
                                            tooltip={item.label}
                                        >
                                            <NavLink to={item.to} end={item.end}>
                                                <item.icon />
                                                <span>{item.label}</span>
                                            </NavLink>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                );
                            })}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>

                <SidebarGroup className="mt-auto">
                    <SidebarGroupContent>
                        <ProcessingIndicator collapsed={collapsed} />
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>

            <SidebarFooter>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton asChild tooltip="Support">
                            <a href="mailto:support@example.com">
                                <CircleHelp />
                                <span>Support</span>
                            </a>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <SidebarMenuButton asChild tooltip="Feedback">
                            <a href="mailto:feedback@example.com">
                                <Send />
                                <span>Feedback</span>
                            </a>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <SidebarMenuButton
                                    size="lg"
                                    aria-label="Profile menu"
                                    className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                                    tooltip={displayName}
                                >
                                    <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-semibold">
                                        {initial}
                                    </div>
                                    <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                                        <span className="truncate font-semibold">
                                            {displayName}
                                        </span>
                                        <span className="truncate text-xs text-sidebar-foreground/70">
                                            {subtitle}
                                        </span>
                                    </div>
                                    <ChevronsUpDown className="ml-auto size-4" />
                                </SidebarMenuButton>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                                side={isMobile ? 'bottom' : 'right'}
                                align="end"
                                sideOffset={4}
                            >
                                <DropdownMenuLabel className="p-0 font-normal">
                                    <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                                        <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-semibold">
                                            {initial}
                                        </div>
                                        <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                                            <span className="truncate font-semibold">
                                                {displayName}
                                            </span>
                                            <span className="truncate text-xs text-muted-foreground">
                                                {subtitle}
                                            </span>
                                        </div>
                                    </div>
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuGroup>
                                    <DropdownMenuItem>
                                        <Sparkles />
                                        Upgrade to Pro
                                    </DropdownMenuItem>
                                </DropdownMenuGroup>
                                <DropdownMenuSeparator />
                                <DropdownMenuGroup>
                                    <DropdownMenuItem>
                                        <ShieldCheck />
                                        Account
                                    </DropdownMenuItem>
                                    <DropdownMenuItem>
                                        <CreditCard />
                                        Billing
                                    </DropdownMenuItem>
                                    <DropdownMenuItem>
                                        <Bell />
                                        Notifications
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onSelect={toggleTheme}>
                                        <ThemeIcon />
                                        {theme === 'light' ? 'Dark mode' : 'Light mode'}
                                    </DropdownMenuItem>
                                </DropdownMenuGroup>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => void handleLogout()}>
                                    <LogOut />
                                    Log out
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
            <SidebarRail />
        </SidebarRoot>
    );
}
