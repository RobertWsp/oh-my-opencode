import type { AvailableSkill } from "../../agents/dynamic-agent-prompt-builder";
import type { HookName, OhMyOpenCodeConfig } from "../../config";
import type { LoadedSkill } from "../../features/opencode-skill-loader/types";
import type { PluginContext } from "../types";

import {
  createAutoSlashCommandHook,
  createCategorySkillReminderHook,
  createSkillErrorReactorHook,
  createSkillDomainDetectorHook,
  createSkillCompactionReloaderHook,
} from "../../hooks";
import { contextCollector } from "../../features/context-injector";
import { safeCreateHook } from "../../shared/safe-create-hook";

export type SkillHooks = {
  categorySkillReminder: ReturnType<
    typeof createCategorySkillReminderHook
  > | null;
  autoSlashCommand: ReturnType<typeof createAutoSlashCommandHook> | null;
  skillErrorReactor: ReturnType<typeof createSkillErrorReactorHook> | null;
  skillDomainDetector: ReturnType<typeof createSkillDomainDetectorHook> | null;
  skillCompactionReloader: ReturnType<
    typeof createSkillCompactionReloaderHook
  > | null;
};

export function createSkillHooks(args: {
  ctx: PluginContext;
  pluginConfig: OhMyOpenCodeConfig;
  isHookEnabled: (hookName: HookName) => boolean;
  safeHookEnabled: boolean;
  mergedSkills: LoadedSkill[];
  availableSkills: AvailableSkill[];
}): SkillHooks {
  const {
    ctx,
    pluginConfig,
    isHookEnabled,
    safeHookEnabled,
    mergedSkills,
    availableSkills,
  } = args;

  const safeHook = <T>(hookName: HookName, factory: () => T): T | null =>
    safeCreateHook(hookName, factory, { enabled: safeHookEnabled });

  const categorySkillReminder = isHookEnabled("category-skill-reminder")
    ? safeHook("category-skill-reminder", () =>
        createCategorySkillReminderHook(ctx, availableSkills),
      )
    : null;

  const autoSlashCommand = isHookEnabled("auto-slash-command")
    ? safeHook("auto-slash-command", () =>
        createAutoSlashCommandHook({
          skills: mergedSkills,
          pluginsEnabled: pluginConfig.claude_code?.plugins ?? true,
          enabledPluginsOverride: pluginConfig.claude_code?.plugins_override,
        }),
      )
    : null;

  const skillErrorReactor = isHookEnabled("skill-error-reactor")
    ? safeHook("skill-error-reactor", () =>
        createSkillErrorReactorHook(availableSkills),
      )
    : null;

  const skillDomainDetector = isHookEnabled("skill-domain-detector")
    ? safeHook("skill-domain-detector", () =>
        createSkillDomainDetectorHook(availableSkills),
      )
    : null;

  const skillCompactionReloader = isHookEnabled("skill-compaction-reloader")
    ? safeHook("skill-compaction-reloader", () =>
        createSkillCompactionReloaderHook(availableSkills, contextCollector),
      )
    : null;

  return {
    categorySkillReminder,
    autoSlashCommand,
    skillErrorReactor,
    skillDomainDetector,
    skillCompactionReloader,
  };
}
