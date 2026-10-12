import { Routes } from 'discord.js';
import { commands } from './commands.js';
export async function registerGuild(rest, applicationId, guildId) {
  // Name-based upsert preserves unrelated application commands.
  for (const body of commands) await rest.post(Routes.applicationGuildCommands(applicationId, guildId), { body });
}
