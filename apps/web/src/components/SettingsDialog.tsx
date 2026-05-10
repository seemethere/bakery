import { useEffect, useMemo, useState } from "react";
import type { AppSettings, SessionRuntimeSettings } from "@pi-web-agent/protocol";
import {
  DatabaseIcon,
  PaintbrushIcon,
  SaveIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { saveThemePreference, storedThemePreference, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

type SettingsSectionId = "connection" | "appearance" | "metadata";

type Props = {
  open: boolean;
  runtimeSettings: SessionRuntimeSettings | null;
  appSettings: AppSettings | null;
  apiBase: string;
  token: string;
  onOpenChange: (open: boolean) => void;
  onSaveConnection: (apiBase: string, token: string) => void;
  onSaveAppSettings: (settings: Partial<AppSettings>) => void;
};

const sections: Array<{ id: SettingsSectionId; label: string; description: string; icon: React.ReactNode }> = [
  {
    id: "connection",
    label: "Connection",
    description: "Stored locally in this browser. Saving refreshes server data from the selected API.",
    icon: <DatabaseIcon />,
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme preference applies immediately and can follow system appearance.",
    icon: <PaintbrushIcon />,
  },
  {
    id: "metadata",
    label: "Session metadata",
    description: "Choose the model used for explicit title and summary generation.",
    icon: <SparklesIcon />,
  },
];

export function SettingsDialog({
  open,
  runtimeSettings,
  appSettings,
  apiBase: initialApiBase,
  token: initialToken,
  onOpenChange,
  onSaveConnection,
  onSaveAppSettings,
}: Props) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("connection");
  const [apiBase, setApiBase] = useState(initialApiBase);
  const [token, setToken] = useState(initialToken);
  const [theme, setTheme] = useState<ThemePreference>(storedThemePreference);

  useEffect(() => {
    if (!open) return;
    setApiBase(initialApiBase);
    setToken(initialToken);
    setTheme(storedThemePreference());
  }, [initialApiBase, initialToken, open]);

  function handleThemeChange(value: ThemePreference) {
    setTheme(value);
    saveThemePreference(value);
  }

  const models = runtimeSettings?.availableModels ?? [];
  const selectedMetadataModel = appSettings?.sessionMetadataModel?.model ?? "";
  const activeSectionDetails = useMemo(
    () => sections.find((section) => section.id === activeSection) ?? sections[0]!,
    [activeSection],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="settings-dialog settings-page grid h-[min(680px,calc(100dvh-1rem))] overflow-hidden p-0 sm:max-w-[min(920px,calc(100vw-2rem))]"
        showCloseButton
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Update local connection, appearance, and session metadata settings.
        </DialogDescription>

        <SidebarProvider
          defaultOpen
          className="min-h-0 items-start overflow-hidden"
          style={{ "--sidebar-width": "15rem" } as React.CSSProperties}
        >
          <Sidebar
            collapsible="none"
            className="hidden border-r border-sidebar-border md:flex"
          >
            <SidebarContent>
              <SidebarGroup>
                <div className="flex items-center gap-2 px-2 py-2 text-sm font-medium text-sidebar-foreground">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                    <SettingsIcon className="size-4" />
                  </span>
                  <span>Settings</span>
                </div>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {sections.map((section) => (
                      <SidebarMenuItem key={section.id}>
                        <SidebarMenuButton
                          isActive={activeSection === section.id}
                          onClick={() => setActiveSection(section.id)}
                        >
                          {section.icon}
                          <span>{section.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>

          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <header className="flex shrink-0 items-start gap-3 border-b px-4 py-3 pr-12 sm:py-4">
              <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground md:hidden">
                <SettingsIcon className="size-4" />
              </div>
              <div className="grid min-w-0 gap-1">
                <h2 className="m-0 truncate text-lg font-semibold text-foreground sm:text-xl">{activeSectionDetails.label}</h2>
                <p className="m-0 max-w-2xl text-xs leading-5 text-muted-foreground sm:text-sm">{activeSectionDetails.description}</p>
              </div>
            </header>

            <div className="border-b px-4 py-2 md:hidden">
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                {sections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className={cn(
                      "flex h-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-4",
                      activeSection === section.id && "bg-background text-foreground shadow-sm",
                    )}
                    aria-label={section.label}
                    aria-pressed={activeSection === section.id}
                    onClick={() => setActiveSection(section.id)}
                  >
                    {section.icon}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-5">
              {activeSection === "connection" && (
                <SettingsPanel ariaLabel="Connection settings">
                  <label className={labelClass}>
                    API base
                    <Input
                      id="apiBase"
                      value={apiBase}
                      onChange={(event) => setApiBase(event.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <label className={labelClass}>
                    Token
                    <Input
                      id="token"
                      type="password"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <Button
                    id="saveSettings"
                    type="button"
                    onClick={() => onSaveConnection(apiBase, token)}
                    className="w-full justify-center"
                  >
                    <SaveIcon />
                    Save / Refresh
                  </Button>
                </SettingsPanel>
              )}

              {activeSection === "appearance" && (
                <SettingsPanel ariaLabel="Appearance settings">
                  <label className={labelClass}>
                    Theme
                    <Select
                      value={theme}
                      onValueChange={(value) => handleThemeChange(value as ThemePreference)}
                    >
                      <SelectTrigger id="themePreference">
                        <SelectValue>
                          {themeLabel(theme)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="system" selected={theme === "system"}>System</SelectItem>
                        <SelectItem value="workbench-dark" selected={theme === "workbench-dark"}>Dark</SelectItem>
                        <SelectItem value="workbench-light" selected={theme === "workbench-light"}>Light</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                </SettingsPanel>
              )}

              {activeSection === "metadata" && (
                <SettingsPanel ariaLabel="Session metadata settings">
                  <label className={labelClass}>
                    Metadata model
                    <Select
                      value={selectedMetadataModel}
                      onValueChange={(value) =>
                        onSaveAppSettings({ sessionMetadataModel: { model: value ?? "" } })
                      }
                    >
                      <SelectTrigger id="sessionMetadataModel">
                        <SelectValue>
                          {metadataModelLabel(models, selectedMetadataModel)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="" selected={selectedMetadataModel === ""}>
                          Default / active model
                        </SelectItem>
                        {models.map((model) => (
                          <SelectItem
                            key={model.id}
                            value={model.id}
                            selected={selectedMetadataModel === model.id}
                          >
                            {model.name ?? model.id} [{model.provider}]
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <p className="m-0 text-xs text-muted-foreground">
                    Titles and summaries are generated only from the sparkle action in session details. Manual fields stay protected.
                  </p>
                </SettingsPanel>
              )}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}

function SettingsPanel({
  ariaLabel,
  children,
}: {
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="grid max-w-2xl gap-4"
      aria-label={ariaLabel}
    >
      {children}
    </section>
  );
}

function themeLabel(theme: ThemePreference): string {
  if (theme === "workbench-dark") return "Dark";
  if (theme === "workbench-light") return "Light";
  return "System";
}

function metadataModelLabel(
  models: NonNullable<SessionRuntimeSettings["availableModels"]>,
  selectedModel: string,
): string {
  if (!selectedModel) return "Default / active model";
  const model = models.find((item) => item.id === selectedModel);
  return model ? `${model.name ?? model.id} [${model.provider}]` : selectedModel;
}

const labelClass = "grid gap-1.5 text-xs font-medium text-muted-foreground";
